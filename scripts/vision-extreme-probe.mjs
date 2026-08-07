// Extreme-case test: no-reasoning + no-vision capability model
// Tests: (1) can a model without vision describe a red circle? (2) can it do reasoning tasks?
// Uses qwen-plus-2025-07-28 (lightest/most basic model on the gate).
import fs from "node:fs";

const BASE = "https://ergreg.burger-king.com.tr/v1/chat/completions";
const DIR = "C:/Users/Unkno/AppData/Local/Temp/vision-test";

async function chat(model, messages, maxTokens = 100) {
	const body = { model, messages, max_tokens: maxTokens, stream: false };
	const t0 = Date.now();
	const res = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const elapsed = Date.now() - t0;
	const j = await res.json().catch(() => null);
	return { status: res.status, elapsed, content: j?.choices?.[0]?.message?.content ?? JSON.stringify(j?.error ?? j) };
}

const b64 = fs.readFileSync(`${DIR}/circle-red.png`).toString("base64");
const imageMsg = {
	role: "user",
	content: [
		{ type: "text", text: "What shape and color do you see? Answer in 5 words. If you cannot see, say CANNOT_SEE" },
		{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
	],
};

const models = [
	{ name: "qwen-plus-2025-07-28", note: "TEXT-ONLY (lightest)" },
	{ name: "qwen3.7-max", note: "TEXT-ONLY (flagship)" },
	{ name: "qwen3-vl-plus", note: "VISION control" },
];

for (const m of models) {
	// Vision part
	const v = await chat(m.name, [imageMsg], 40);
	console.log(`\n=== ${m.name} [${m.note}] ===`);
	console.log(`VISION test  [${v.status} ${v.elapsed}ms]: ${v.content.trim().slice(0, 100)}`);

	// Reasoning part (no image) — logic question requiring inference
	const r = await chat(m.name, [
		{ role: "user", content: "If a clock shows 3:15, what is the angle between the hour and minute hands? Just the number." },
	], 40);
	console.log(`REASON test  [${r.status} ${r.elapsed}ms]: ${r.content.trim().slice(0, 100)}`);
}
