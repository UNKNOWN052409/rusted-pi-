/**
 * Real audit runner — calls the Sryze proxy LLM and audits a real code snippet
 * through the code-audit engine. Not a gate; evidence for diagnosis and
 * per-model audit assignment.
 *
 *   npx tsx scripts/audit-runner.ts [modelId]
 *
 * Default model: kilwa-grok-4.3/kilwa-grok-4.3 (the only one that generates
 * content on this proxy).
 */
import type { Model } from "@earendil-works/pi-ai";
import { auditCode } from "../packages/agent/src/harness/tools/code-audit.ts";

const BASE_URL = "https://ourproxy.sryze.cc/v1";
const API_KEY = process.env.SRYZE_API_KEY ?? "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL_ID = process.argv[2] ?? "kilwa-grok-4.3/kilwa-grok-4.3";

function makeModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
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
}

// A real snippet from the repo with known issues (console.log) plus clean code.
const SNIPPET = `export function stripDiffMarkers(text: string): string {
  return text
    .split("\\n")
    .map((line) => (line.startsWith("+") ? line.slice(1) : line))
    .join("\\n");
}

export function countChangedLines(diffText: string): number {
  const lines = diffText.split("\\n");
  console.log("counting lines:", lines.length);
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("+")) count++;
  }
  return count;
}`;

const model = makeModel(MODEL_ID);
console.log(`Auditing with model: ${model.id}`);
console.log(`Base URL: ${model.baseUrl}`);
console.log("---");

const result = await auditCode(SNIPPET, {
	fileType: "ts",
	auditModel: model,
	apiKey: API_KEY,
	timeoutMs: 45000,
});

console.log(`Pass: ${result.pass}`);
console.log(`LLM skipped: ${result.llmSkipped}`);
console.log(`Audit model: ${result.auditModel ?? "(none)"}`);
console.log(`Findings: ${result.findings.length}`);
for (const f of result.findings) {
	console.log(`  [${f.severity}] (${f.engine}${f.line !== undefined ? `:${f.line}` : ""}) ${f.kind}: ${f.detail}`);
}
console.log("---");
console.log("Raw pass result above; LLM response parsed by parseAuditResponse (LINE <n>: <msg> format).");
