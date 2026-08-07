// Vision capability probe: text-only model vs vision model on Qwen Gate
// Usage: node scripts/vision-capability-probe.mjs
import fs from "node:fs";

const BASE = "https://ergreg.burger-king.com.tr/v1/chat/completions";
const FRAME = "C:/Users/Unkno/AppData/Local/Temp/vision-test/frames/frame1.jpg";

const imageB64 = fs.readFileSync(FRAME).toString("base64");
const dataUrl = `data:image/jpeg;base64,${imageB64}`;

const models = [
	{ name: "qwen3-coder-plus", note: "TEXT-ONLY (modalities: text)" },
	{ name: "qwen3-vl-plus", note: "VISION (modalities: text,image,video)" },
];

async function send(model) {
	const body = {
		model,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe what you see in this image in one short sentence. If you cannot see the image, say exactly: CANNOT_SEE" },
					{ type: "image_url", image_url: { url: dataUrl } },
				],
			},
		],
		max_tokens: 100,
		stream: false,
	};
	const t0 = Date.now();
	const res = await fetch(BASE, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const elapsed = Date.now() - t0;
	const text = await res.text();
	return { status: res.status, elapsed, body: text };
}

for (const m of models) {
	try {
		const r = await send(m.name);
		console.log(`\n=== ${m.name} [${m.note}] status=${r.status} ${r.elapsed}ms ===`);
		let parsed = null;
		try {
			parsed = JSON.parse(r.body);
		} catch {
			parsed = r.body.slice(0, 500);
		}
		if (parsed && typeof parsed === "object") {
			const content = parsed.choices?.[0]?.message?.content;
			console.log("reply:", JSON.stringify(content).slice(0, 800));
			if (parsed.error) console.log("error:", JSON.stringify(parsed.error));
		} else {
			console.log("raw:", String(parsed).slice(0, 800));
		}
	} catch (e) {
		console.log(`\n=== ${m.name} === EXCEPTION: ${e.message}`);
	}
}
