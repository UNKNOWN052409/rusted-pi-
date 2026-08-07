/** Isolate the 403: capture the exact SDK payload via onPayload and try variations. */
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

async function run(label: string, opts: Record<string, unknown> = {}): Promise<void> {
	const stream = streamSimple(
		model,
		{
			system: "You are a code auditor.",
			messages: [{ role: "user", content: "Say ok" }],
		},
		{
			apiKey: API_KEY,
			onPayload: (payload) => {
				console.log(`\n[${label}] PAYLOAD:`, JSON.stringify(payload, null, 1).slice(0, 1500));
			},
			onResponse: (resp) => {
				console.log(`[${label}] RESPONSE STATUS:`, resp.status);
			},
			...opts,
		} as never,
	);
	let out = "";
	for await (const ev of stream) {
		if (ev.type === "text-delta") out += ev.text;
		if (ev.type === "error") console.log(`[${label}] STREAM ERROR:`, JSON.stringify(ev.error).slice(0, 400));
	}
	const result = await stream.result();
	console.log(`[${label}] RESULT:`, JSON.stringify({ stopReason: result.stopReason, content: result.content, errorMessage: result.errorMessage ?? null }).slice(0, 400));
}

await run("default");
