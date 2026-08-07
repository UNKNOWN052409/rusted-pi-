import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryOffset, TelegramBridge, type TelegramUpdate } from "../../src/telegram-bridge.ts";

/**
 * Real HTTP test harness: spins up a local HTTP server that mimics the
 * Telegram Bot API (getUpdates / sendMessage), then points the bridge at it
 * with the real node fetch. No real bot token, no external network.
 */
function makeBotServer(): {
	server: Server;
	baseUrl: string;
	updates: TelegramUpdate[];
	sent: Array<{ chat_id: number; text: string }>;
	setUpdates(updates: TelegramUpdate[]): void;
	close(): Promise<void>;
} {
	const updates: TelegramUpdate[] = [];
	const sent: Array<{ chat_id: number; text: string }> = [];
	let offset = 0;

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
			const method = req.url?.split("/").pop() ?? "";
			if (method === "getUpdates") {
				const from = Number(parsed.offset ?? 0);
				const fresh = updates.filter((u) => u.update_id > from);
				if (fresh.length > 0) offset = Math.max(offset, ...fresh.map((u) => u.update_id));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, result: fresh }));
			} else if (method === "sendMessage") {
				sent.push({ chat_id: Number(parsed.chat_id), text: String(parsed.text) });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
			} else {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, description: "not found" }));
			}
		});
	});

	return {
		server,
		baseUrl: "",
		updates,
		sent,
		setUpdates(u: TelegramUpdate[]) {
			updates.length = 0;
			updates.push(...u);
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("TelegramBridge (real local HTTP bot API)", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
	});

	it("sends a reply for an incoming text message", async () => {
		const bot = makeBotServer();
		servers.push(bot.server);
		bot.baseUrl = await listen(bot.server);

		const replies: string[] = [];
		const bridge = new TelegramBridge({
			token: "test-token",
			baseUrl: bot.baseUrl,
			pollIntervalMs: 10,
			longPollTimeoutMs: 1000,
			onUpdate: async (update) => {
				replies.push(update.message?.text ?? "");
				return `you said: ${update.message?.text}`;
			},
		});

		bot.setUpdates([{ update_id: 1, message: { message_id: 10, chat: { id: 42 }, text: "hello" } }]);
		const started = new Promise<void>((resolve) => {
			const orig = bridge.start.bind(bridge);
			void orig().then(resolve);
		});
		await sleep(300);
		bridge.stop();
		await started;

		expect(replies).toEqual(["hello"]);
		expect(bot.sent).toEqual([{ chat_id: 42, text: "you said: hello" }]);
	});

	it("does not reply when the handler returns nothing", async () => {
		const bot = makeBotServer();
		servers.push(bot.server);
		bot.baseUrl = await listen(bot.server);

		const bridge = new TelegramBridge({
			token: "t",
			baseUrl: bot.baseUrl,
			pollIntervalMs: 10,
			longPollTimeoutMs: 1000,
			onUpdate: () => undefined,
		});
		bot.setUpdates([{ update_id: 5, message: { message_id: 1, chat: { id: 7 }, text: "ignored" } }]);
		const started = new Promise<void>((resolve) => void bridge.start().then(resolve));
		await sleep(200);
		bridge.stop();
		await started;

		expect(bot.sent).toEqual([]);
	});

	it("sends an error message when the handler throws", async () => {
		const bot = makeBotServer();
		servers.push(bot.server);
		bot.baseUrl = await listen(bot.server);

		const bridge = new TelegramBridge({
			token: "t",
			baseUrl: bot.baseUrl,
			pollIntervalMs: 10,
			longPollTimeoutMs: 1000,
			onUpdate: () => {
				throw new Error("boom");
			},
		});
		bot.setUpdates([{ update_id: 9, message: { message_id: 2, chat: { id: 3 }, text: "x" } }]);
		const started = new Promise<void>((resolve) => void bridge.start().then(resolve));
		await sleep(200);
		bridge.stop();
		await started;

		expect(bot.sent.length).toBe(1);
		expect(bot.sent[0].text).toContain("Error: boom");
	});

	it("persists the offset so already-seen updates are not replayed", async () => {
		const bot = makeBotServer();
		servers.push(bot.server);
		bot.baseUrl = await listen(bot.server);
		const offset = createMemoryOffset();

		const bridge = new TelegramBridge({
			token: "t",
			baseUrl: bot.baseUrl,
			pollIntervalMs: 10,
			longPollTimeoutMs: 1000,
			offset,
			onUpdate: () => "ok",
		});
		bot.setUpdates([
			{ update_id: 100, message: { message_id: 3, chat: { id: 1 }, text: "first" } },
			{ update_id: 101, message: { message_id: 4, chat: { id: 1 }, text: "second" } },
		]);
		const started = new Promise<void>((resolve) => void bridge.start().then(resolve));
		await sleep(200);
		bridge.stop();
		await started;

		expect(await offset.get()).toBe(101);
	});

	it("throws on API errors from sendMessage (e.g. invalid token)", async () => {
		const bot = makeBotServer();
		servers.push(bot.server);
		bot.baseUrl = await listen(bot.server);
		// Make the server fail getUpdates (simulating a bad token) by responding 401.
		const failing = createServer((_req, res) => {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
		});
		servers.push(failing);
		const failingUrl = await listen(failing);

		const bridge = new TelegramBridge({
			token: "bad-token",
			baseUrl: failingUrl,
			pollIntervalMs: 10,
			longPollTimeoutMs: 1000,
			onUpdate: () => "irrelevant",
		});
		// The poll loop swallows transient errors; direct sendMessage should throw.
		await expect(bridge.sendMessage(1, "hi")).rejects.toThrow(/HTTP 401/);
	});
});
