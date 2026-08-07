/** Raw streamSimple probe — show exactly what the proxy LLM returns for the audit prompt. */
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

const stream = streamSimple(
	model,
	{
		system:
			'You are a code auditor. Audit the code and reply with findings in this exact format, one per line:\nLINE <n>: <issue description>\nIf no issues, reply exactly: NO_ISSUES',
		messages: [
			{
				role: "user",
				content:
					'export function countChangedLines(diffText: string): number {\n  const lines = diffText.split("\\n");\n  console.log("counting lines:", lines.length);\n  return lines.filter((l) => l.startsWith("+")).length;\n}',
			},
		],
	},
	{ maxTokens: 1024, apiKey: API_KEY },
);

let out = "";
for await (const ev of stream) {
	if (ev.type === "text-delta") out += ev.text;
	if (ev.type === "error") out += `\n[STREAM ERROR] ${ev.error.message}`;
}
const result = await stream.result();
console.log("=== streamed text ===");
console.log(out || "(empty)");
console.log("=== result ===");
console.log(JSON.stringify(
	{ stopReason: result.stopReason, content: result.content, errorMessage: result.errorMessage ?? null },
	null,
	2,
));
