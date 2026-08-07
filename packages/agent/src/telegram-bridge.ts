/**
 * Telegram remote-control bridge — dependency-free.
 *
 * Speaks the Telegram Bot API over plain fetch with long-polling
 * (getUpdates). Chat messages are forwarded to a user-supplied handler and
 * replies are sent back via sendMessage. The fetch implementation and chat
 * handler are injected so tests can run against a local HTTP server with no
 * real bot token and no external network.
 */

export interface TelegramBridgeOptions {
	/** Bot token from @BotFather (ignored when fetch is injected). */
	token: string;
	/** Update offset persistence (default: in-memory). */
	offset?: { get(): Promise<number>; set(offset: number): Promise<void> };
	/** Poll interval ms (default 1000). */
	pollIntervalMs?: number;
	/** Timeout for getUpdates long poll (default 25s; Telegram max). */
	longPollTimeoutMs?: number;
	/** Base URL override for tests (default https://api.telegram.org/bot<token>). */
	baseUrl?: string;
	/** fetch implementation override for tests. */
	fetchImpl?: typeof fetch;
	/** Called with every update; reply by returning a string. */
	onUpdate?: (update: TelegramUpdate) => Promise<string | undefined> | string | undefined;
	/** Started flag callback for tests. */
	onStart?: (started: boolean) => void;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type?: string };
	text?: string;
	from?: { id: number; first_name?: string; username?: string };
	date?: number;
}

export interface TelegramSendResult {
	ok: boolean;
	description?: string;
	message_id?: number;
}

/** In-memory offset store (default). */
export function createMemoryOffset(): { get(): Promise<number>; set(offset: number): Promise<void> } {
	let value = 0;
	return {
		async get() {
			return value;
		},
		async set(offset: number) {
			value = offset;
		},
	};
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LONG_POLL_MS = 25_000;

export class TelegramBridge {
	private stopped = false;
	private readonly fetchImpl: typeof fetch;
	private readonly offset: { get(): Promise<number>; set(offset: number): Promise<void> };
	private readonly pollIntervalMs: number;
	private readonly longPollTimeoutMs: number;
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly onUpdate?: TelegramBridgeOptions["onUpdate"];
	private readonly onStart?: TelegramBridgeOptions["onStart"];

	constructor(options: TelegramBridgeOptions) {
		this.token = options.token;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.offset = options.offset ?? createMemoryOffset();
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
		this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_MS;
		this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${encodeURIComponent(options.token)}`;
		this.onUpdate = options.onUpdate;
		this.onStart = options.onStart;
	}

	private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
		const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Telegram API ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
		if (!json.ok) {
			throw new Error(`Telegram API ${method} error: ${json.description ?? "unknown"}`);
		}
		return json.result;
	}

	/** Send a plain text message to a chat. */
	async sendMessage(chatId: number, text: string): Promise<TelegramSendResult> {
		const result = (await this.api("sendMessage", {
			chat_id: chatId,
			text,
		})) as { message_id?: number };
		return { ok: true, message_id: result?.message_id };
	}

	private async getUpdates(offset: number, timeoutMs: number): Promise<TelegramUpdate[]> {
		const result = (await this.api("getUpdates", {
			offset,
			timeout: Math.floor(timeoutMs / 1000),
		})) as TelegramUpdate[] | undefined;
		return Array.isArray(result) ? result : [];
	}

	private async pollOnce(): Promise<number> {
		const offset = await this.offset.get();
		let updates: TelegramUpdate[];
		try {
			updates = await this.getUpdates(offset, this.longPollTimeoutMs);
		} catch {
			// Transient API errors (network, 409 conflict, etc.): back off and retry.
			return offset;
		}
		let maxId = offset;
		for (const update of updates) {
			if (update.update_id > maxId) maxId = update.update_id;
			await this.handleUpdate(update);
		}
		if (maxId > offset) {
			await this.offset.set(maxId);
		}
		return maxId;
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (!message?.text) return;
		try {
			const reply = await this.onUpdate?.(update);
			if (typeof reply === "string" && reply.length > 0) {
				await this.sendMessage(message.chat.id, reply);
			}
		} catch (error) {
			// Never let a handler crash the poll loop.
			const err = error instanceof Error ? error : new Error(String(error));
			try {
				await this.sendMessage(message.chat.id, `Error: ${err.message.slice(0, 500)}`);
			} catch {
				// Swallow send failures for error replies.
			}
		}
	}

	/** Start the long-poll loop. Resolves when stop() is called. */
	async start(): Promise<void> {
		this.stopped = false;
		this.onStart?.(true);
		while (!this.stopped) {
			await this.pollOnce();
			await new Promise((r) => setTimeout(r, this.pollIntervalMs));
		}
		this.onStart?.(false);
	}

	stop(): void {
		this.stopped = true;
	}
}
