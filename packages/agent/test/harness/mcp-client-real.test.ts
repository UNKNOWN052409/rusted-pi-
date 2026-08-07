import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callMcpTool, connectMcpServer, discoverMcpServer, type McpServerConfig } from "../../src/mcp-client.ts";

/**
 * A real MCP stdio server implemented in Node: spawns a subprocess that speaks
 * JSON-RPC 2.0 over stdin/stdout. No mocks — real pipes, real JSON parsing.
 * Escaped as a JS string so the written file contains real newlines.
 */
const ECHO_SERVER = [
	`const readline = require('node:readline');`,
	`const rl = readline.createInterface({ input: process.stdin });`,
	`const send = (p) => process.stdout.write(JSON.stringify(p) + '\\n');`,
	`rl.on('line', (line) => {`,
	`  let msg; try { msg = JSON.parse(line); } catch { return; }`,
	`  if (msg.method === 'initialize') {`,
	`    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-server', version: '1.0.0' } } });`,
	`  } else if (msg.method === 'notifications/initialized') {`,
	`    // no response`,
	`  } else if (msg.method === 'tools/list') {`,
	`    send({ jsonrpc: '2.0', id: msg.id, result: [`,
	`      { name: 'echo', description: 'Echo back the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },`,
	`      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }`,
	`    ] });`,
	`  } else if (msg.method === 'tools/call') {`,
	`    const params = msg.params || {};`,
	`    if (params.name === 'echo') {`,
	`      const text = (params.arguments && params.arguments.text) || '';`,
	`      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + text }] } });`,
	`    } else if (params.name === 'add') {`,
	`      const a = (params.arguments && params.arguments.a) || 0;`,
	`      const b = (params.arguments && params.arguments.b) || 0;`,
	`      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });`,
	`    } else {`,
	`      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool' } });`,
	`    }`,
	`  } else {`,
	`    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });`,
	`  }`,
	`});`,
].join("\n");

function writeEchoServer(dir: string): string {
	const file = join(dir, "echo-mcp-server.cjs");
	writeFileSync(file, ECHO_SERVER);
	return file;
}

function serverConfig(dir: string): McpServerConfig {
	return {
		name: "echo",
		command: process.execPath,
		args: [writeEchoServer(dir)],
	};
}

describe("mcp-client (real stdio subprocess)", () => {
	it("connects, lists tools, and calls echo tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		const conn = await connectMcpServer(serverConfig(dir));
		expect(conn.protocolVersion).toBe("2024-11-05");
		expect(conn.tools.map((t) => t.name)).toEqual(["echo", "add"]);
		expect(conn.tools[0].description).toContain("Echo back");

		const result = await conn.client.call("echo", { text: "hello world" });
		expect(result.ok).toBe(true);
		expect(result.content[0].text).toBe("echo:hello world");
		conn.client.close();
	});

	it("calls the add tool with numbers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		const conn = await connectMcpServer(serverConfig(dir));
		const result = await conn.callTool("add", { a: 20, b: 22 });
		expect(result.ok).toBe(true);
		expect(result.content[0].text).toBe("42");
		conn.client.close();
	});

	it("returns an error result for unknown tools", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		const conn = await connectMcpServer(serverConfig(dir));
		const result = await conn.callTool("nonexistent", {});
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
		conn.client.close();
	});

	it("discovers a server from mcp.json in a repo dir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-repo-"));
		const script = writeEchoServer(dir);
		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					echo: { command: process.execPath.replace(/\\/g, "/"), args: [script.replace(/\\/g, "/")] },
				},
			}),
		);
		const conn = await discoverMcpServer(dir);
		expect(conn.server.name).toBe("echo");
		expect(conn.tools.map((t) => t.name)).toEqual(["echo", "add"]);
		const result = await conn.callTool("echo", { text: "via discovery" });
		expect(result.content[0].text).toBe("echo:via discovery");
		conn.client.close();
	});

	it("throws when no mcp.json exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-empty-"));
		await expect(discoverMcpServer(dir)).rejects.toThrow("No MCP server configuration found");
	});

	it("throws when the server command does not exist", async () => {
		await expect(
			connectMcpServer({ name: "ghost", command: "definitely-not-a-real-command-xyz", args: [] }),
		).rejects.toThrow();
	});

	it("times out when the server never responds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-timeout-"));
		const silentJs = join(dir, "silent.cjs");
		writeFileSync(silentJs, "process.stdin.resume();\n"); // never replies
		await expect(
			connectMcpServer({ name: "silent", command: process.execPath, args: [silentJs] }, { timeoutMs: 1000 }),
		).rejects.toThrow("timed out");
	});

	it("callMcpTool convenience wrapper works on a live connection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		const conn = await connectMcpServer(serverConfig(dir));
		const result = await callMcpTool(conn, "add", { a: 1, b: 2 });
		expect(result.ok).toBe(true);
		expect(result.content[0].text).toBe("3");
		conn.client.close();
	});
});
