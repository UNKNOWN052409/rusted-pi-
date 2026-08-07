// QA ramp probe: how many concurrent agents fit in a 0.1-core (10% of one core) budget?
// Each agent = one API call to oc/deepseek-v4-flash-free. Measures node process CPU only.
import { execSync } from "node:child_process";

const API = "http://localhost:20128/v1";
const KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL = "oc/deepseek-v4-flash-free";
const BUDGET = 10; // 0.1 core = 10% of one core
const CALLS_PER_LEVEL = 40;
const LEVELS = [1, 2, 4, 8, 12, 16, 24];

async function callModel(i) {
	const body = JSON.stringify({
		model: MODEL,
		stream: false,
		messages: [{ role: "user", content: `Reply with exactly the number ${i}` }],
		max_tokens: 30,
	});
	const res = await fetch(`${API}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body,
	});
	const text = await res.text();
	try {
		const j = JSON.parse(text);
		return { ok: true, content: j.choices?.[0]?.message?.content ?? "", usage: j.usage };
	} catch {
		return { ok: false };
	}
}

async function runLevel(concurrency, calls) {
	const cpuBefore = process.cpuUsage();
	const t0 = Date.now();
	const tasks = Array.from({ length: calls }, (_, i) => () => callModel(i));
	const results = new Array(tasks.length);
	let cursor = 0;
	async function worker() {
		while (cursor < tasks.length) {
			const idx = cursor++;
			results[idx] = await tasks[idx]();
		}
	}
	const workers = Array.from({ length: concurrency }, worker);
	await Promise.all(workers);
	const wall = Date.now() - t0;
	const cpu = process.cpuUsage(cpuBefore);
	const cpuMs = (cpu.user + cpu.system) / 1000;
	const pct = (cpuMs / wall) * 100; // % of ONE core
	const ok = results.filter((r) => r.ok);
	const withContent = ok.filter((r) => r.content && r.content.trim().length > 0);
	return { concurrency, wall, pct, ok: ok.length, content: withContent.length };
}

console.log(`model: ${MODEL} | budget: 0.1 core = ${BUDGET}% of one core`);
console.log("concurrency | wall(ms) | cpu% of 1 core | http-ok | with-content | fits");
for (const level of LEVELS) {
	const r = await runLevel(level, CALLS_PER_LEVEL);
	const fits = r.pct <= BUDGET ? "YES" : "NO";
	console.log(
		`${String(r.concurrency).padStart(11)} | ${String(r.wall).padStart(8)} | ${String(r.pct.toFixed(2)).padStart(12)} | ${String(r.ok).padStart(7)} | ${String(r.content).padStart(12)} | ${fits}`,
	);
}