// QA probe: 100 parallel API calls to oc/deepseek-v4-flash-free (non-stream) while sampling CPU%.
import { execSync } from "node:child_process";

const API = "http://localhost:20128/v1";
const KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL = "oc/deepseek-v4-flash-free";

// CPU sampler via powershell Get-Counter
const cpuSamples = [];
const sampler = setInterval(() => {
	try {
		const out = execSync(
			'powershell -NoProfile -Command "(Get-Counter \'\\Processor Information(_Total)\\% Processor Time\' -SampleInterval 1).CounterSamples[0].CookedValue"',
			{ encoding: "utf8", shell: "cmd", timeout: 8000 },
		);
		cpuSamples.push(parseFloat(out.trim()));
	} catch {
		/* ignore */
	}
}, 1200);

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
			reasoning: j.choices?.[0]?.message?.reasoning_content ?? "",
			usage: j.usage,
		};
	} catch {
		return { i, ok: false, raw: `HTTP ${res.status}: ${text.slice(0, 100)}` };
	}
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: 100 }, (_, i) => callModel(i)));
const wall = Date.now() - t0;

clearInterval(sampler);
await new Promise((r) => setTimeout(r, 300));

const ok = results.filter((r) => r.ok);
const withContent = ok.filter((r) => r.content && r.content.trim().length > 0);
const withAny = ok.filter((r) => (r.content || r.reasoning).trim().length > 0);
const totalTokens = ok.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0);

console.log(`model: ${MODEL} (non-stream)`);
console.log(
	`tasks: 100 (${ok.length} http-ok, ${withContent.length} with-content, ${withAny.length} with-any-output, ${ok.length - withAny.length} empty)`,
);
console.log(`wall: ${wall} ms (${(wall / 100).toFixed(1)} ms/call, ${(100000 / wall).toFixed(1)} calls/s)`);
console.log(`completion tokens: ${totalTokens}`);

if (cpuSamples.length > 0) {
	const avg = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;
	const max = Math.max(...cpuSamples);
	console.log(
		`CPU: avg ${avg.toFixed(1)}%  peak ${max.toFixed(1)}%  samples ${cpuSamples.length} (16 cores; 0.1 core of one = 0.625% of total)`,
	);
} else {
	console.log("CPU: no samples");
}
console.log(
	`sample contents: ${withContent
		.slice(0, 3)
		.map((r) => `#${r.i}="${r.content.trim()}"`)
		.join(", ")}`,
);