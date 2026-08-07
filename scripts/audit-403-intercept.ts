/** PoC v3: onPayload body-rewrite + custom fetch (UA set + non-SSE->SSE conversion), full logging. */
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://ourproxy.sryze.cc/v1";
const API_KEY = process.env.SRYZE_API_KEY ?? "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL_ID = process.argv[2] ?? "kilwa-grok-4.3/kilwa-grok-4.3";

const model: Model<"openai-completions"> = {
	id: MODEL_ID,
	name: MODEL_ID,
	api: "openai-completions",
	provider: "sryze",
	baseUrl: BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	headers: { Authorization: `Bearer ${API_KEY}` },
};

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

const proxyFetch: typeof fetch = async (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set("user-agent", "openai-node/4.x");
	const res = await fetch(input, { ...init, headers });
	console.log("[fetch] status:", res.status, "ct:", res.headers.get("content-type"));
	if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const t = await res.text().catch(() => "");
		console.log("[fetch] passthrough body:", JSON.stringify(t.slice(0, 150)));
		return res;
	}
	const raw = await res.text();
	console.log("[fetch] raw resp:", JSON.stringify(raw.slice(0, 200)));
	const cleaned = raw.replace(/\s*data: \[DONE\]\s*$/, "").trim();
	let comp: any;
	try {
		comp = JSON.parse(cleaned);
	} catch (e) {
		console.log("[fetch] JSON.parse failed:", (e as Error).message, JSON.stringify(raw.slice(0, 120)));
		return new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	const msg = comp.choices?.[0]?.message;
	const finish = comp.choices?.[0]?.finish_reason ?? "stop";
	const base = { id: comp.id ?? "chatcmpl-proxy", object: "chat.completion.chunk", created: comp.created ?? Math.floor(Date.now() / 1000), model: comp.model ?? MODEL_ID };
	const chunks: string[] = [];
	chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
	if (msg?.content) chunks.push(sse({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] }));
	chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
	if (comp.usage) chunks.push(sse({ ...base, choices: [], usage: comp.usage }));
	chunks.push("data: [DONE]\n\n");
	console.log("[fetch] converted to", chunks.length, "SSE chunks");
	return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};

const stream = streamSimple(
	model,
	{
		system: "You are a code auditor.",
		messages: [{ role: "user", content: "Say ok in one word" }],
	},
	{
		apiKey: API_KEY,
		fetch: proxyFetch,
		onResponse: (resp) => console.log("onResponse STATUS:", resp.status),
		onPayload: (params) => {
			const p = { ...params } as Record<string, unknown>;
			delete p["max_completion_tokens"];
			delete p["stream_options"];
			delete p["store"];
			(p as Record<string, unknown>)["max_tokens"] = 1024;
			console.log("[onPayload] rewritten keys:", Object.keys(p).join(","));
			return p as never;
		},
	} as never,
);

let out = "";
for await (const ev of stream) {
	if (ev.type === "text-delta") out += ev.text;
	if (ev.type === "error") console.log("STREAM ERROR:", JSON.stringify(ev.error).slice(0, 300));
}
const result = await stream.result();
console.log("RESULT:", JSON.stringify({ stopReason: result.stopReason, content: result.content, errorMessage: result.errorMessage ?? null }).slice(0, 400));
