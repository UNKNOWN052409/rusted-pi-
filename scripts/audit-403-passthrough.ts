import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";

const BASE_URL = "https://ourproxy.sryze.cc/v1";
const API_KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL_ID = "kilwa-grok-4.3/kilwa-grok-4.3";
const model: Model<"openai-completions"> = {
  id: MODEL_ID, name: MODEL_ID, api: "openai-completions", provider: "sryze",
  baseUrl: BASE_URL, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
  headers: { Authorization: `Bearer ${API_KEY}` },
};
const proxyFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", "openai-node/4.x");
  const res = await fetch(input, { ...init, headers });
  console.log("[passthrough] status:", res.status, "ct:", res.headers.get("content-type"));
  return res;
};
const stream = streamSimple(model, { system: "You are a code auditor.", messages: [{ role: "user", content: "Say ok in one word" }] },
  { apiKey: API_KEY, fetch: proxyFetch, onResponse: (r) => console.log("onResponse STATUS:", r.status) } as never);
let out = "";
for await (const ev of stream) {
  if (ev.type === "text-delta") out += ev.text;
  if (ev.type === "error") console.log("STREAM ERROR:", JSON.stringify(ev.error).slice(0, 250));
}
const result = await stream.result();
console.log("RESULT:", JSON.stringify({ stopReason: result.stopReason, content: result.content, errorMessage: result.errorMessage ?? null }).slice(0, 300));
