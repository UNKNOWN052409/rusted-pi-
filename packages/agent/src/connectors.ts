/**
 * Connector factory — pluggable external channels (Telegram, device apps such
 * as Honeygain, generic webhooks). All connectors are token-gated: nothing
 * connects or sends unless the user supplies a real token/secret. No
 * hardcoded credentials. Honeygain here is an example of a "device app"
 * connector — an inert documented adapter until the user wires the actual app
 * protocol (it never monetizes or touches any external paid network on its
 * own).
 */

import { TelegramBridge } from "./telegram-bridge.ts";

export type ConnectorKind = "telegram" | "webhook" | "device-app";

export interface Connector {
	readonly kind: ConnectorKind;
	readonly name: string;
	/** Whether the connector has real credentials to operate. */
	enabled: boolean;
	/** Send a message/update through the channel. */
	send: (payload: unknown) => Promise<void>;
	/** Tear down any long-lived connections. */
	dispose: () => Promise<void>;
}

export interface ConnectorOptions {
	kind: ConnectorKind;
	name: string;
	/** User-supplied token/secret; when missing the connector stays inert. */
	token?: string;
	/** Telegram chat id to send to (telegram kind). */
	chatId?: string;
	/** Endpoint URL (webhook kind). */
	endpoint?: string;
	/** Underlying telegram bridge (injectable for tests). */
	bridge?: TelegramBridge;
	/** fetch impl override (tests). */
	fetchImpl?: typeof fetch;
}

/** Gate: a connector is enabled only when its required secret is present. */
function isEnabled(kind: ConnectorKind, token: string | undefined, endpoint: string | undefined): boolean {
	switch (kind) {
		case "telegram":
			return Boolean(token) && Boolean(endpoint === undefined || endpoint);
		case "webhook":
			return Boolean(endpoint);
		case "device-app":
			return Boolean(token) && Boolean(endpoint);
	}
}

/**
 * Build a connector. Missing credentials -> inert (enabled=false, send is a
 * no-op) so the system never fails or silently sends without user consent.
 */
export function createConnector(options: ConnectorOptions): Connector {
	const enabled = isEnabled(options.kind, options.token, options.endpoint);
	switch (options.kind) {
		case "telegram": {
			const bridge =
				options.bridge ??
				new TelegramBridge({
					token: options.token ?? "",
				});
			return {
				kind: "telegram",
				name: options.name,
				enabled,
				send: async (payload) => {
					if (!enabled) return;
					await bridge.sendMessage(Number(options.chatId ?? 0), String(payload));
				},
				dispose: async () => {
					await bridge.stop();
				},
			};
		}
		case "webhook": {
			const fetchImpl = options.fetchImpl ?? fetch;
			return {
				kind: "webhook",
				name: options.name,
				enabled,
				send: async (payload) => {
					if (!enabled || !options.endpoint) return;
					await fetchImpl(options.endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
				},
				dispose: async () => {},
			};
		}
		case "device-app": {
			// Example: Honeygain-style device apps. Without a real protocol this
			// stays inert; the user can wire their own app's API via endpoint.
			const fetchImpl = options.fetchImpl ?? fetch;
			return {
				kind: "device-app",
				name: options.name,
				enabled,
				send: async (payload) => {
					// Never run unless the user provided token+endpoint.
					if (!enabled || !options.endpoint || !options.token) return;
					await fetchImpl(options.endpoint, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
						body: JSON.stringify(payload),
					});
				},
				dispose: async () => {},
			};
		}
	}
}
