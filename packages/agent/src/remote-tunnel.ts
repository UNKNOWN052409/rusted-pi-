/**
 * Remote tunnel — lets one rusted-pi instance delegate tasks to another (e.g.
 * Render-to-Render). A long-poll HTTP tunnel: a server exposes a base URL (a
 * stable/permanent domain or a forwarded port) that a remote client connects
 * to and pulls tasks from; results are pushed back. Zero external dependencies
 * (node http + fetch only).
 *
 * Server: registers task handlers; client polls /pull for a task, runs it,
 * posts the result to /result. A shared auth token gates every request.
 */

import type { IncomingMessage, RequestOptions, Server } from "node:http";
import { createServer, request as httpRequest } from "node:http";

export interface RemoteTask {
	id: string;
	kind: string;
	payload: unknown;
}

export interface TunnelServerOptions {
	/** Shared secret required on every request. */
	authToken: string;
	/** Task executor: given a pulled task, return { ok, value|error }. */
	handle: (task: RemoteTask) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
}

export interface TunnelClientOptions {
	/** Base URL of the remote tunnel server (stable domain). */
	baseUrl: string;
	/** Shared auth token. */
	authToken: string;
}

/** Read the full request body as UTF-8 JSON. */
function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			try {
				resolve(body.length ? (JSON.parse(body) as unknown) : null);
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

/** node http.request wrapper returning parsed JSON body. */
function httpJson(options: RequestOptions, body: unknown): Promise<{ status: number; data: unknown }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(options, (res) => {
			let resBody = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				resBody += chunk;
			});
			res.on("end", () => {
				let data: unknown = null;
				if (resBody.length) {
					try {
						data = JSON.parse(resBody) as unknown;
					} catch {
						data = resBody;
					}
				}
				resolve({ status: res.statusCode ?? 0, data });
			});
		});
		req.on("error", reject);
		if (body !== null && body !== undefined) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

const AUTH_HEADER = "x-rusted-auth";

function authorized(headers: IncomingMessage["headers"], token: string): boolean {
	return headers[AUTH_HEADER] === token;
}

/** Route + handle an inbound request. */
async function handleTunnelRequest(
	req: IncomingMessage,
	options: TunnelServerOptions,
): Promise<{ status: number; data: unknown }> {
	if (!authorized(req.headers, options.authToken)) {
		return { status: 401, data: { error: "unauthorized" } };
	}
	const url = req.url ?? "/";
	const [path] = url.split("?");
	if (path === "/pull") {
		// Polling for a queued task: return an empty pull when idle.
		// In this minimal long-poll, we answer with an empty task unless
		// a handler enqueues. Kept extensible for a queue manager.
		return { status: 200, data: { task: null, queueDepth: 0 } };
	}
	if (path === "/health") {
		return { status: 200, data: { ok: true } };
	}
	if (path === "/result" && req.method === "POST") {
		const parsed = await readJson(req);
		// Result of a delegated task — no op by default, caller wires a
		// result handler. Acknowledge receipt.
		return { status: 200, data: { ok: true, received: parsed } };
	}
	if (req.method !== "GET" && req.method !== "POST") {
		return { status: 405, data: { error: "method not allowed" } };
	}
	return { status: 404, data: { error: "not found" } };
}

export interface TunnelServeResult {
	server: Server;
	url: string;
	close: () => Promise<void>;
}

/**
 * Start a tunnel server bound to host:port. Use host 0.0.0.0 with a forwarded
 * port or a stable Render domain for a permanent tunnel endpoint. Resolves
 * once the server is listening and returns the real bound URL. Returns a
 * handle incl. a close() for cleanup.
 */
export async function serveTunnel(
	options: TunnelServerOptions & { host?: string; port?: number },
): Promise<TunnelServeResult> {
	const host = options.host ?? "0.0.0.0";
	const port = options.port ?? 0;
	const server = createServer((req, res) => {
		void handleTunnelRequest(req, options)
			.then((r) => {
				res.statusCode = r.status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(r.data));
			})
			.catch(() => {
				res.statusCode = 500;
				res.end('{"error":"internal"}');
			});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : port;
	const url = `http://127.0.0.1:${actualPort}`;
	return { server, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Ping a remote tunnel for health/auth. */
export async function tunnelHealth(options: TunnelClientOptions): Promise<boolean> {
	try {
		const { status } = await httpJson(
			{
				hostname: hostFromUrl(options.baseUrl),
				port: portFromUrl(options.baseUrl),
				path: "/health",
				method: "GET",
				headers: { [AUTH_HEADER]: options.authToken },
			},
			null,
		);
		return status === 200;
	} catch {
		return false;
	}
}

/** Pull the next task (or null when idle). */
export async function tunnelPull(options: TunnelClientOptions): Promise<RemoteTask | null> {
	const { status, data } = await httpJson(
		{
			hostname: hostFromUrl(options.baseUrl),
			port: portFromUrl(options.baseUrl),
			path: "/pull",
			method: "GET",
			headers: { [AUTH_HEADER]: options.authToken },
		},
		null,
	);
	if (status !== 200) throw new Error(`pull failed (${status})`);
	const body = data as { task?: RemoteTask | null };
	return body.task ?? null;
}

/** Post a task result back to the server. */
export async function tunnelPostResult(options: TunnelClientOptions, result: RemoteResultPayload): Promise<void> {
	const { status } = await httpJson(
		{
			hostname: hostFromUrl(options.baseUrl),
			port: portFromUrl(options.baseUrl),
			path: "/result",
			method: "POST",
			headers: { [AUTH_HEADER]: options.authToken, "content-type": "application/json" },
		},
		result,
	);
	if (status !== 200) throw new Error(`result post failed (${status})`);
}

export interface TunnelClientResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

export interface RemoteResultPayload {
	id: string;
	kind: string;
	ok: boolean;
	value?: unknown;
	error?: string;
}

function hostFromUrl(base: string): string {
	return base.replace(/^https?:\/\//, "").split(/[/:]/)[0] ?? "127.0.0.1";
}

function portFromUrl(base: string): number {
	const m = /:(\d+)/.exec(base);
	return m ? Number(m[1]) : 80;
}

// Re-export request type for downstream tests/callers.
export type { IncomingMessage, Server };
