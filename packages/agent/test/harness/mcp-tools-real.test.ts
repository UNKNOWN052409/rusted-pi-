import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

const models = createModels();

import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createMcpTool, createMcpTools } from "../../src/harness/tools/mcp-tools.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import type { ExecutionToolContext } from "../../src/harness/tools/tool-context.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { connectMcpServer, type McpServerConfig } from "../../src/mcp-client.ts";

/** Real MCP echo server — same fixture pattern as mcp-client-real.test.ts. */
const ECHO_SERVER = [
	`const readline = require('node:readline');`,
	`const rl = readline.createInterface({ input: process.stdin });`,
	`const send = (p) => process.stdout.write(JSON.stringify(p) + '\\n');`,
	`rl.on('line', (line) => {`,
	`  let msg; try { msg = JSON.parse(line); } catch { return; }`,
	`  if (msg.method === 'initialize') {`,
	`    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-server', version: '1.0.0' } } });`,
	`  } else if (msg.method === 'tools/list') {`,
	`    send({ jsonrpc: '2.0', id: msg.id, result: [`,
	`      { name: 'echo', description: 'Echo back the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }`,
	`    ] });`,
	`  } else if (msg.method === 'tools/call') {`,
	`    const params = msg.params || {};`,
	`    if (params.name === 'echo') {`,
	`      const text = (params.arguments && params.arguments.text) || '';`,
	`      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + text }] } });`,
	`    } else {`,
	`      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'tool isError' }], isError: true } });`,
	`    }`,
	`  }`,
	`});`,
].join("\n");

function makeServerConfig(dir: string): McpServerConfig {
	const file = join(dir, "echo-mcp-server.cjs");
	writeFileSync(file, ECHO_SERVER);
	return { name: "echo", command: process.execPath, args: [file] };
}

describe("mcp-tools (bridge to AgentHarnessTool)", () => {
	it("createMcpTools builds one harness tool per server tool with namespaced name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
		const conn = await connectMcpServer(makeServerConfig(dir));
		const tools = createMcpTools(conn);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("echo_echo");
		expect(tools[0].description).toContain("Echo back");
		conn.client.close();
	});

	it("createMcpTool executes through the real subprocess and returns text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
		const conn = await connectMcpServer(makeServerConfig(dir));
		const tool = createMcpTool(conn, conn.tools[0]);
		const result = await tool.execute("call-1", { text: "bridge hello" }, undefined, undefined, {
			env: new NodeExecutionEnv({ cwd: dir }),
		});
		expect(result.content).toEqual([{ type: "text", text: "echo:bridge hello" }]);
		conn.client.close();
	});

	it("reports MCP errors as text content instead of throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
		const conn = await connectMcpServer(makeServerConfig(dir));
		const tool = createMcpTool(conn, { name: "missing", description: "x", inputSchema: {} });
		const result = await tool.execute("call-2", {}, undefined, undefined, {
			env: new NodeExecutionEnv({ cwd: dir }),
		});
		expect(result.content[0].type).toBe("text");
		expect(String((result.content[0] as { text?: unknown }).text)).toContain("failed");
		conn.client.close();
	});

	it("MCP tools plug into AgentHarness alongside builtin tools", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
		const conn = await connectMcpServer(makeServerConfig(dir));
		const mcpTool = createMcpTool(conn, conn.tools[0]);
		const env = new NodeExecutionEnv({ cwd: dir });
		const harness = new AgentHarness<ExecutionToolContext>({
			resources: { skills: [] },
			tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool(), mcpTool],
			toolContext: { env },
			session: new Session(new InMemorySessionStorage()),
			models,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});
		const allNames = harness.getTools().map((t) => t.name);
		expect(allNames).toContain("echo_echo");
		expect(allNames).toContain("bash");
		expect(allNames).toContain("read");
		conn.client.close();
	});
});
