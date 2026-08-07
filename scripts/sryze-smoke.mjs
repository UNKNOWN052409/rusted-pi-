/**
 * Sryze proxy smoke test — verifies the diagnosis that the proxy at
 * https://ourproxy.sryze.cc/v1 has broken native tool-calling and broken
 * streaming. Run with:
 *
 *   node scripts/sryze-smoke.mjs
 *
 * Exit code 0 = all probes behaved as expected (or were honest failures);
 * exit code 1 = an unexpected behavior was observed.
 */
const BASE_URL = "https://ourproxy.sryze.cc/v1";
const API_KEY = process.env.SRYZE_API_KEY ?? "sk-6fdefd57386cfe2a-ra242r-af2d3f16";

const MODELS = [
	"kilwa-grok-4.3/kilwa-grok-4.3",
	"longcat/longcat-flash",
	"longcat/longcat-flash-thinking",
];

let failures = 0;
let pass = 0;

function report(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures++;
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

async function probe(model, body) {
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model, ...body }),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// keep null — non-JSON response
	}
	return { status: res.status, text, json };
}

// ---------------------------------------------------------------------------
// 1. Model listing
// ---------------------------------------------------------------------------
console.log("\n[1] Model listing");
try {
	const res = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
	const json = await res.json();
	const ids = (json.data ?? []).map((m) => m.id);
	for (const model of MODELS) {
		report(`${model} listed`, ids.includes(model), ids.includes(model) ? "present" : "MISSING");
	}
} catch (error) {
	for (const model of MODELS) report(`${model} listed`, false, String(error));
}

// ---------------------------------------------------------------------------
// 2. Tool-calling support (native tool_calls expected)
// ---------------------------------------------------------------------------
console.log("\n[2] Native tool-calling (get_weather tool, tool_choice auto)");
for (const model of MODELS) {
	const { status, json } = await probe(model, {
		stream: false,
		max_tokens: 120,
		messages: [
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
		],
		tools: [
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Get the current weather for a location",
					parameters: {
						type: "object",
						properties: { location: { type: "string" } },
						required: ["location"],
					},
				},
			},
		],
		tool_choice: "auto",
	});
	if (!json) {
		report(`${model} tool-call`, false, `HTTP ${status}, non-JSON`);
		continue;
	}
	if (json.error) {
		report(`${model} tool-call`, false, `API error: ${json.error.message ?? JSON.stringify(json.error)}`);
		continue;
	}
	const choice = json.choices?.[0];
	const msg = choice?.message ?? {};
	const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
	const finish = choice?.finish_reason;
	// Expected honest behavior from the proxy: prose reply, finish_reason stop,
	// no tool_calls field. We PASS when the behavior matches the known diagnosis
	// (the point of this script is to confirm/regress the diagnosis, not to lie).
	report(
		`${model} tool-call`,
		!hasToolCalls && finish === "stop",
		hasToolCalls
			? `UNEXPECTED native tool call: ${msg.tool_calls[0].function.name}`
			: `prose reply, finish=${finish} (native tool-calling NOT supported — expected)`,
	);
}

// ---------------------------------------------------------------------------
// 3. Streaming behavior
// ---------------------------------------------------------------------------
console.log("\n[3] Streaming (stream: true — SSE content chunks expected)");
for (const model of MODELS) {
	const { status, text, json } = await probe(model, {
		stream: true,
		max_tokens: 40,
		messages: [{ role: "user", content: "Say hello in three words." }],
	});
	if (!text.includes("data:")) {
		report(`${model} stream`, false, `HTTP ${status}, no SSE framing`);
		continue;
	}
	const chunks = text.split("\n").filter((l) => l.startsWith("data: "));
	const contentChunks = chunks.filter((c) => {
		try {
			const j = JSON.parse(c.slice(6));
			return j.choices?.[0]?.delta?.content;
		} catch {
			return false;
		}
	});
	// Diagnosed behavior:
	//  - kilwa: single non-streamed JSON object + trailing "data: [DONE]" (not SSE at all)
	//  - longcat: SSE framing BUT all deltas empty (completion_tokens: 0) — content never arrives
	const isBroken =
		(chunks.length === 0 && json && json.choices) || // single-shot JSON, not SSE
		contentChunks.length === 0; // SSE framing with zero content deltas
	report(
		`${model} stream`,
		isBroken,
		isBroken
			? contentChunks.length === 0
				? `SSE framing but ${chunks.length} chunk(s), all empty deltas (0 completion tokens — no content streamed — expected)`
				: `single-shot JSON + data: [DONE], no SSE chunks (expected)`
			: `got ${contentChunks.length} content chunks (streaming may work — revisit diagnosis)`,
	);
}

// ---------------------------------------------------------------------------
// 4. Plain (non-streaming, non-tool) completion — the reliable path
// ---------------------------------------------------------------------------
console.log("\n[4] Plain completion (stream:false, no tools)");
for (const model of MODELS) {
	const { status, json } = await probe(model, {
		stream: false,
		max_tokens: 40,
		messages: [{ role: "user", content: "Reply with exactly: ok" }],
	});
	const content = json?.choices?.[0]?.message?.content ?? "";
	// Longcat models can return a JSON array-of-content-blocks under .content
	// (e.g. [{"type":"text","text":"ok"}]) instead of a plain string.
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((c) => (c && typeof c === "object" ? c.text : "")).join("")
				: String(content ?? "");
	const ok = typeof text === "string" && text.trim().length > 0 && !json?.error;
	// Longcat models return empty content with ~2000 injected prompt tokens on
	// this proxy — they cannot generate at all. Only kilwa-grok-4.3 produces
	// usable output. This is an expected regression check, not a gate.
	report(
		`${model} plain completion`,
		ok || (text.trim().length === 0 && json?.usage?.completion_tokens === 0),
		ok
			? `content="${text.trim().slice(0, 30)}"`
			: text.trim().length === 0
				? `empty content (completion_tokens 0) — longcat generation broken on this proxy (expected)`
				: `HTTP ${status}, content="${text.trim().slice(0, 30)}"`,
	);
}

console.log(`\nSummary: ${pass} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
