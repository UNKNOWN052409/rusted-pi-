// QA probe: sequential (0.1-core budget) calls to oc/deepseek-v4-flash-free.
// Measures node process CPU precisely via process.cpuUsage() — the only honest
// way to prove 0.1-core economy (network-bound workload should idle CPU).
import { execSync } from "node:child_process";

const API = "http://localhost:20128/v1";
const KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL = "oc/deepseek-v4-flash-free";
const N = 100;
const CONCURRENCY = 1; // 0.1-core budget => strictly sequential

const cpuBefore = process.cpuUsage();

async function callModel(i) {
	const body = JSON.stringify({
		model: MODEL,
		stream: false,
		messages: [{ role: "user", content: `Reply with exactly the number ${i}` }],
		max_tokens: 50,
	});
	const res = await fetch(`${API}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body,
	});
	const text = await res.text();
	try {
		const j = JSON.parse(text);
		return {
			i,
			ok: true,
			content: j.choices?.[0]?.message?.content ?? "",
			usage: j.usage,
		};
	} catch {
		return { i, ok: false, raw: `HTTP ${res.status}: ${text.slice(0, 100)}` };
	}
}

// Concurrency-limited runner (sequential here)
async function runAll(tasks, limit) {
	const results = new Array(tasks.length);
	let cursor = 0;
	async function worker() {
		while (cursor < tasks.length) {
			const idx = cursor++;
			results[idx] = await tasks[idx](idx);
		}
	}
	const workers = Array.from({ length: limit }, worker);
	await Promise.all(workers);
	return results;
}

const t0 = Date.now();
const results = await runAll(Array.from({ length: N }, (_, i) => () => callModel(i)), CONCURRENCY);
const wall = Date.now() - t0;
const cpuAfter = process.cpuUsage(cpuBefore);

const ok = results.filter((r) => r.ok);
const withContent = ok.filter((r) => r.content && r.content.trim().length > 0);
const totalTokens = ok.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0);

const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000; // ms of CPU time
const cpuPctOfOneCore = (cpuMs / wall) * 100; // % of ONE core during the run

console.log(`model: ${MODEL} (non-stream)`);
console.log(`mode: sequential (concurrency ${CONCURRENCY}) — 0.1-core budget`);
console.log(
	`tasks: ${N} (${ok.length} http-ok, ${withContent.length} with-content, ${ok.length - withContent.length} empty)`,
);
console.log(`wall: ${wall} ms (${(wall / N).toFixed(1)} ms/call, ${(N * 1000 / wall).toFixed(1)} calls/s)`);
console.log(`completion tokens: ${totalTokens}`);
console.log(`node process CPU: ${cpuMs.toFixed(1)} ms total over ${wall} ms wall`);
console.log(`=> ${cpuPctOfOneCore.toFixed(2)}% of one core (0.1 core = 10%)`);
console.log(`=> ${(cpuPctOfOneCore / 10).toFixed(2)}x of 0.1-core budget`);