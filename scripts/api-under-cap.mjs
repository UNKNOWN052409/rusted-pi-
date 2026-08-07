// api-under-cap.mjs — fire 8 concurrent real API calls from a 0.1-core-capped
// client; the router (localhost:20128, GPU server) is a separate UNCAPED process.
// Handles SSE streaming responses (data: {...} lines, [DONE] terminator).
import { execSync } from "node:child_process";

const BASE = "http://localhost:20128/v1";
const KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";

async function call(i) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "oc/deepseek-v4-flash-free",
      messages: [{ role: "user", content: `Reply with exactly one word: ${i}` }],
      max_tokens: 32,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    console.log(`[call ${i}] HTTP ${res.status} ${Date.now() - t0}ms`);
    return;
  }
  let text = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        text += j?.choices?.[0]?.delta?.content ?? "";
      } catch {}
    }
  }
  console.log(`[call ${i}] ${Date.now() - t0}ms -> ${JSON.stringify(text).slice(0, 40)}`);
}

const samples = [];
const iv = setInterval(() => {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader"
    ).toString().trim();
    samples.push(out);
  } catch {}
}, 500);

(async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => call(i)));
  await new Promise((r) => setTimeout(r, 1500));
  clearInterval(iv);
  const peak = Math.max(...samples.map((s) => parseInt(s.split(",")[0], 10) || 0));
  const last = samples.slice(-3);
  console.log("=== GPU server-side (last 3 samples) ===");
  last.forEach((s) => console.log(s));
  console.log(`peak util: ${peak}%`);
  process.exit(0);
})();
