// Video frame-sequence test: does the model understand temporal change across frames?
// Sends 3 frames from a video (t=2s, t=30s, t=60s) as a multi-image sequence.
import fs from "node:fs";

const BASE = "https://ergreg.burger-king.com.tr/v1/chat/completions";
const DIR = "C:/Users/Unkno/AppData/Local/Temp/vision-test/frames";

const models = [
	{ name: "qwen3-vl-plus", note: "video modality" },
	{ name: "qwen3.5-flash", note: "image+video modality" },
	{ name: "qwen3-coder-plus", note: "TEXT-ONLY" },
];

async function send(model) {
	const frames = ["f0.jpg", "f1.jpg", "f2.jpg"].map((f) => {
		const b64 = fs.readFileSync(`${DIR}/${f}`).toString("base64");
		return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } };
	});
	const body = {
		model,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "These are three frames (t=2s, t=30s, t=60s) from a video. Describe what is happening and whether the scene changes between frames. If you cannot see the images, say exactly: CANNOT_SEE",
					},
					...frames,
				],
			},
		],
		max_tokens: 200,
		stream: false,
	};
	const t0 = Date.now();
	const res = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const elapsed = Date.now() - t0;
	const json = await res.json().catch(() => null);
	const content = json?.choices?.[0]?.message?.content;
	return { status: res.status, elapsed, content };
}

for (const m of models) {
	try {
		const r = await send(m.name);
		console.log(`\n=== ${m.name} [${m.note}] status=${r.status} ${r.elapsed}ms ===`);
		console.log((r.content ?? "NO CONTENT").slice(0, 900));
	} catch (e) {
		console.log(`\n=== ${m.name} === EXCEPTION: ${e.message}`);
	}
}
