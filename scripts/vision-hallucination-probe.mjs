// Hallucination-check: can text-only models actually SEE, or do they fabricate?
// Sends known solid-color images and checks if the model identifies the color correctly.
import fs from "node:fs";

const BASE = "https://ergreg.burger-king.com.tr/v1/chat/completions";
const DIR = "C:/Users/Unkno/AppData/Local/Temp/vision-test";

// Text-only models per /v1/models modalities
const textOnlyModels = ["qwen3-coder-plus", "qwen3.7-max", "qwen-plus-2025-07-28"];
const visionModel = "qwen3-vl-plus";

const tests = [
	{ file: "solid-red.png", expected: "red" },
	{ file: "solid-green.png", expected: "green" },
	{ file: "solid-blue.png", expected: "blue" },
	{ file: "solid-black.png", expected: "black" },
	{ file: "solid-white.png", expected: "white" },
];

async function ask(model, file, expected) {
	const b64 = fs.readFileSync(`${DIR}/${file}`).toString("base64");
	const body = {
		model,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: `What is the solid color of this image? Answer with a single color name only.` },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
				],
			},
		],
		max_tokens: 20,
		stream: false,
	};
	const t0 = Date.now();
	const res = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const elapsed = Date.now() - t0;
	const json = await res.json().catch(() => null);
	const reply = (json?.choices?.[0]?.message?.content ?? String(json?.error?.message ?? json)).trim().toLowerCase();
	const correct = reply.includes(expected);
	return { status: res.status, elapsed, reply: (json?.choices?.[0]?.message?.content ?? String(json?.error?.message ?? json)).trim(), correct };
}

for (const m of [...textOnlyModels, visionModel]) {
	console.log(`\n########## MODEL: ${m} ##########`);
	for (const t of tests) {
		try {
			const r = await ask(m, t.file, t.expected);
			console.log(`  ${t.file.padEnd(20)} expected=${t.expected.padEnd(6)} -> [${r.status} ${r.elapsed}ms] ${r.reply.slice(0, 80)} ${r.correct ? "CORRECT" : "WRONG/UNKNOWN"}`);
		} catch (e) {
			console.log(`  ${t.file} EXCEPTION: ${e.message}`);
		}
	}
}
