import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AgentToolResult } from "./types.ts";

/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 *
 * No external SDK dependency: speaks the JSON-RPC 2.0 subset used by MCP
 * directly over the server's stdin/stdout. This keeps the agent package
 * dependency-free and lets tests exercise the protocol with a real subprocess.
 */

export interface McpServerConfig {
	/** Arbitrary server name (shown in diagnostics). */
	name: string;
	/** Command to spawn (e.g. `npx`). */
	command: string;
	/** Arguments for the command. */
	args?: string[];
	/** Environment overrides. */
	env?: Record<string, string>;
}

export interface McpToolDefinition {
	/** Tool name as exposed by the server. */
	name: string;
	/** Human-readable description. */
	description?: string;
	/** JSON schema for the tool input. */
	inputSchema: Record<string, unknown>;
}

export interface McpConnection {
	server: McpServerConfig;
	/** Tools the server exposed via tools/list. */
	tools: McpToolDefinition[];
	/** Protocol version negotiated during initialize. */
	protocolVersion: string;
	/** Live client handle; present while the connection is open. */
	client: McpClientHandle;
	/** Convenience: call a tool on this connection (delegates to client.call). */
	callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

/** Opaque handle used to keep the connection object serializable-friendly. */
export interface McpClientHandle {
	/** Call a tool by name with JSON-serializable arguments. */
	call(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
	/** Close the subprocess and release the handle. */
	close(): void;
}

export interface McpToolCallResult {
	ok: boolean;
	/** Structured content returned by the server (tools/call). */
	content: Array<{ type: string; text?: string }>;
	/** Error message when ok is false. */
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** JSON-RPC request/response plumbing over a spawned process stdio. */
class McpClient {
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private stdout = "";
	private closed = false;
	private readonly child: ReturnType<typeof spawn>;
	private readonly timeoutMs: number;

	constructor(child: ReturnType<typeof spawn>, timeoutMs: number) {
		this.child = child;
		this.timeoutMs = timeoutMs;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.stdout += chunk;
			this.drain();
		});
	}

	private drain(): void {
		let idx = this.stdout.indexOf("\n");
		while (idx !== -1) {
			const line = this.stdout.slice(0, idx).trim();
			this.stdout = this.stdout.slice(idx + 1);
			if (!line) {
				idx = this.stdout.indexOf("\n");
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				idx = this.stdout.indexOf("\n");
				continue; // non-JSON noise on stdout; ignore
			}
			const msg = parsed as { id?: number; result?: unknown; error?: unknown };
			if (typeof msg.id !== "number") {
				idx = this.stdout.indexOf("\n");
				continue;
			}
			const entry = this.pending.get(msg.id);
			if (!entry) {
				idx = this.stdout.indexOf("\n");
				continue;
			}
			clearTimeout(entry.timer);
			this.pending.delete(msg.id);
			if (msg.error !== undefined) {
				entry.reject(
					new Error(typeof msg.error === "object" && msg.error !== null ? JSON.stringify(msg.error) : "rpc error"),
				);
			} else {
				entry.resolve(msg.result);
			}
			idx = this.stdout.indexOf("\n");
		}
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	/** Fire-and-forget notification (MCP notifications receive no response). */
	notify(method: string, params?: unknown): void {
		this.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private write(payload: string): void {
		if (this.closed || !this.child.stdin?.writable) return;
		this.child.stdin.write(payload);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin?.end();
		this.child.kill();
		for (const { timer, reject } of this.pending.values()) {
			clearTimeout(timer);
			reject(new Error("MCP client closed"));
		}
		this.pending.clear();
	}

	/** Reject every pending request (e.g. on a sync spawn error). */
	failAll(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const { timer, reject } of this.pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		this.pending.clear();
	}
}

function spawnServer(server: McpServerConfig, onError?: (e: Error) => void): ReturnType<typeof spawn> {
	// shell: false always — shell: true on Windows mangles arguments with spaces
	// (e.g. process.execPath under C:\Users\... with spaces) and concatenates them
	// unquoted, so the child never starts. Direct spawn preserves argv boundaries.
	const child = spawn(server.command, server.args ?? [], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...server.env },
		shell: false,
	});
	// A sync spawn failure (e.g. nonexistent command, ENOENT) fires the 'error'
	// event asynchronously. Surface it so pending requests reject instead of
	// hanging until the timeout.
	child.on("error", (e) => {
		onError?.(e instanceof Error ? e : new Error(String(e)));
	});
	return child;
}

function normalizeTools(toolsResult: unknown): McpToolDefinition[] {
	if (!Array.isArray(toolsResult)) return [];
	return toolsResult.map((t) => {
		const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
		return {
			name: String(tool.name ?? ""),
			description: typeof tool.description === "string" ? tool.description : undefined,
			inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
		};
	});
}

function normalizeToolCallResult(result: unknown): McpToolCallResult {
	// MCP spec: tools/call returns an object { content: [...], isError?: boolean }.
	const raw =
		typeof result === "object" && result !== null && "content" in result
			? (result as { content?: unknown }).content
			: result;
	const content = Array.isArray(raw)
		? raw
				.map((part) => {
					const p = part as { type?: unknown; text?: unknown };
					return { type: String(p.type ?? ""), text: typeof p.text === "string" ? p.text : undefined };
				})
				.filter((p) => p.type !== "")
		: [];
	const isError =
		typeof result === "object" && result !== null && "isError" in result
			? Boolean((result as { isError?: unknown }).isError)
			: false;
	if (isError)
		return { ok: false, content, error: content.map((c) => c.text ?? "").join("\n") || "tool returned isError" };
	return { ok: true, content };
}

/**
 * Connect to an MCP stdio server: spawn, initialize, tools/list, and return a
 * live connection with a callable handle. The caller must close() the handle.
 */
export async function connectMcpServer(
	server: McpServerConfig,
	options?: { timeoutMs?: number },
): Promise<McpConnection> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const child = spawnServer(server, (e) => client?.failAll(e));
	const client = new McpClient(child, timeoutMs);

	let protocolVersion = "unknown";
	let tools: McpToolDefinition[] = [];
	try {
		const initResult = await client.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-agent-mcp", version: "0.1.0" },
		});
		if (typeof initResult === "object" && initResult !== null && "protocolVersion" in initResult) {
			protocolVersion = String((initResult as { protocolVersion: unknown }).protocolVersion);
		}
		await client.notify("notifications/initialized");
		tools = normalizeTools(await client.request("tools/list", {}));
	} catch (error) {
		client.close();
		throw error instanceof Error ? error : new Error(String(error));
	}

	const handle: McpClientHandle = {
		async call(toolName, args) {
			try {
				const result = await client.request("tools/call", { name: toolName, arguments: args });
				return normalizeToolCallResult(result);
			} catch (error) {
				return { ok: false, content: [], error: error instanceof Error ? error.message : String(error) };
			}
		},
		close() {
			client.close();
		},
	};

	return {
		server,
		tools,
		protocolVersion,
		client: handle,
		callTool: (toolName, args) => handle.call(toolName, args),
	};
}

/**
 * Auto-discover an MCP server from a repository: looks for `mcp.json` /
 * `.mcp.json` at the repo root. Returns the first server that connects.
 */
export async function discoverMcpServer(repoDir: string, options?: { timeoutMs?: number }): Promise<McpConnection> {
	const candidates: McpServerConfig[] = [];

	for (const file of ["mcp.json", ".mcp.json"]) {
		try {
			const raw = readFileSync(`${repoDir}/${file}`, "utf8");
			const parsed = JSON.parse(raw) as {
				mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
			};
			for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
				candidates.push({ name, command: cfg.command, args: cfg.args, env: cfg.env });
			}
		} catch {
			// Missing or unparseable config; try the next file.
		}
	}

	if (candidates.length === 0) {
		throw new Error(`No MCP server configuration found in ${repoDir} (looked for mcp.json, .mcp.json)`);
	}

	let lastError: Error | undefined;
	for (const candidate of candidates) {
		try {
			return await connectMcpServer(candidate, options);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError ?? new Error("No MCP server could be connected");
}

export type { AgentToolResult };

/** Call a tool on a live connection and return the normalized result. */
export async function callMcpTool(
	connection: McpConnection,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpToolCallResult> {
	return connection.callTool(toolName, args);
}
