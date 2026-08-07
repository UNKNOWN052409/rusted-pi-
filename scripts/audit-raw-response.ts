import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://ourproxy.sryze.cc/v1";
const API_KEY = process.env.SRYZE_API_KEY ?? "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL_ID = process.argv[2] ?? "kilwa-grok-4.3/kilwa-grok-4.3";

const model: Model<"openai-completions"> = {
	id: MODEL_ID, name: MODEL_ID, api: "openai-completions", provider: "sryze",
	baseUrl: BASE_URL, reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 4096,
	headers: { Authorization: `Bearer ${API_KEY}` },
};

const SYSTEM = `You are a strict, honest code auditor. Your job is to find REAL problems in the provided code snippet and report ONLY what you can verify from the code itself.
Rules:
- Do NOT invent problems. If the code is fine, say so.
- Do NOT claim something is broken unless you can point to the exact line.
- Do NOT lie, exaggerate, or fabricate security issues.
- Focus on: correctness bugs, race conditions, resource leaks, security issues, type unsafety, and maintainability.
- Report each finding as a single line in this exact format:
  LINE <n>: <severity> <category> — <one-line description>
  where <n> is the 1-based line number in the snippet, severity is info|warning|error|critical, and category is a short tag like "bug", "security", "perf", "type", "style".
- If there are no real findings, output exactly: NO_ISSUES`;

const CODE = `export function stripDiffMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("+") ? line.slice(1) : line))
    .join("\n");
}

export function countChangedLines(diffText: string): number {
  const lines = diffText.split("\n");
  console.log("counting lines:", lines.length);
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("+")) count++;
  }
  return count;
}`;

const result = await streamSimple(model, {
	systemPrompt: SYSTEM,
	messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: `Audit the following ts code (${CODE.split("\n").length} lines):\n\n\`\`\`\n${CODE}\n\`\`\`` }] }],
}, { apiKey: API_KEY, maxTokens: 1024 }).result();

const text = result.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
console.log("=== RAW LLM RESPONSE (kilwa) ===");
console.log(JSON.stringify(text));
console.log("=== stopReason:", result.stopReason, "errorMessage:", result.errorMessage ?? null);
