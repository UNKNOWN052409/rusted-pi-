import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { openAICompletionsApi } from "../../../ai/src/api/openai-completions.lazy.ts";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage } from "../../src/harness/session/jsonl-storage.ts";
import { Session } from "../../src/harness/session/session.ts";

const API = "http://localhost:20128/v1";
const KEY = "sk-6fdefd57386cfe2a-ra242r-af2d3f16";
const MODEL_ID = "oc/deepseek-v4-flash-free";

describe.skipIf(!process.env.LIVE_HARNESS)("live harness e2e (real API, manual run)", () => {
	it("runs a full prompt turn through AgentHarness against the local router", async () => {
		const cpu0 = process.cpuUsage();
		const t0 = Date.now();

		const models = createModels();
		const provider = createProvider({
			id: "local-oc",
			name: "Local OC Router",
			baseUrl: API,
			auth: {
				apiKey: {
					name: "router key",
					login: async () => ({ type: "api_key", key: KEY }),
					resolve: async () => ({ auth: { apiKey: KEY }, source: "hardcoded" }),
				},
			},
			models: [
				{
					id: MODEL_ID,
					name: "DeepSeek V4 Flash Free",
					api: "openai-completions",
					provider: "local-oc",
					baseUrl: API,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
			api: openAICompletionsApi(),
		});
		models.setProvider(provider);

		const dir = mkdtempSync(join(tmpdir(), "harness-live-"));
		try {
			const env = new NodeExecutionEnv({ cwd: dir });
			const storage = await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), {
				cwd: dir,
				sessionId: "live-oc-1",
			});
			const session = new Session(storage);
			const harness = new AgentHarness<{ env: NodeExecutionEnv }>({
				models,
				session,
				model: provider.getModels()[0],
				systemPrompt: "You are a helpful assistant. Reply concisely.",
				tools: [],
				toolContext: { env },
			});

			const events: string[] = [];
			harness.subscribe((event) => {
				events.push(event.type);
			});

			const reply = await harness.prompt("Reply with exactly the word: PUMA");
			const wall = Date.now() - t0;
			const cpu = process.cpuUsage(cpu0);
			const cpuMs = (cpu.user + cpu.system) / 1000;
			const oneCorePct = (cpuMs / wall) * 100;

			console.log("=== LIVE HARNESS E2E (real API) ===");
			console.log(`model: ${MODEL_ID}`);
			console.log(`reply role: ${reply.role}, content: ${JSON.stringify(reply.content)}`);
			console.log(`wall: ${wall} ms`);
			console.log(`node CPU: ${cpuMs.toFixed(1)} ms => ${oneCorePct.toFixed(2)}% of one core`);
			console.log(`0.1 core budget = 10% of one core => ${(oneCorePct / 10).toFixed(2)}x budget`);
			console.log(`events: ${events.join(",")}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
