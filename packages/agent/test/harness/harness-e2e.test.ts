import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage } from "../../src/harness/session/jsonl-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { calculateTool } from "../utils/calculate.ts";
import { createTempDir } from "./session-test-utils.ts";

/**
 * End-to-end smoke test for the AgentHarness.
 *
 * Exercises the full pipeline with the faux provider so it is deterministic:
 *   session persistence on disk (JSONL) -> prompt -> tool call -> tool result
 *   -> assistant reply -> event stream -> compaction -> branch navigation.
 *
 * This is the "does the whole thing boot and run" gate that would have been
 * covered by a live-LLM e2e but uses the faux provider so it runs anywhere,
 * including low-end devices (Raspberry Pi, Realme C15 via Termux).
 */

const models = createModels();

describe("harness e2e smoke test", () => {
	it("boots a harness, runs a full tool-calling turn, and persists it to disk", async () => {
		const faux = fauxProvider({ provider: "e2e-smoke" });
		models.setProvider(faux.provider);
		faux.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("The answer is 4."),
		]);

		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const storage = await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), {
			cwd: dir,
			sessionId: "e2e-smoke-1",
		});
		const session = new Session(storage);
		const harness = new AgentHarness<{ env: NodeExecutionEnv }>({
			models,
			session,
			model: faux.getModel(),
			systemPrompt: "You are a helpful assistant.",
			tools: [calculateTool],
			toolContext: { env },
		});

		const events: string[] = [];
		harness.subscribe((event) => {
			events.push(event.type);
		});

		const reply = await harness.prompt("What is 2+2?");

		expect(reply.role).toBe("assistant");
		expect(reply.content).toBeDefined();

		// The tool call round trip persisted: user -> tool call -> tool result -> final answer.
		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(messages.some((m) => m.role === "user")).toBe(true);
		expect(messages.some((m) => m.role === "toolResult")).toBe(true);

		// Event stream includes the lifecycle events.
		expect(events).toContain("message_start");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");
		expect(events).toContain("settled");

		// Session metadata is on disk.
		const metadata = await session.getMetadata();
		expect(metadata.id).toBeTruthy();
	});

	it("recovers a persisted session from disk and continues the conversation", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const storage = await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), {
			cwd: dir,
			sessionId: "e2e-recover-1",
		});
		const session = new Session(storage);
		const faux = fauxProvider({ provider: "e2e-recover" });
		models.setProvider(faux.provider);
		faux.setResponses([() => fauxAssistantMessage("first reply")]);

		const harness = new AgentHarness<{ env: NodeExecutionEnv }>({
			models,
			session,
			model: faux.getModel(),
			toolContext: { env },
		});
		await harness.prompt("first message");
		const sessionId = (await session.getMetadata()).id;

		// New harness instance over the same JSONL directory.
		const recovered = new Session(await JsonlSessionStorage.open(env, join(dir, "session.jsonl")));
		const harness2 = new AgentHarness<{ env: NodeExecutionEnv }>({
			models,
			session: recovered,
			model: faux.getModel(),
			toolContext: { env },
		});
		faux.setResponses([() => fauxAssistantMessage("second reply")]);
		await harness2.prompt("second message");

		const entries = await recovered.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect((await recovered.getMetadata()).id).toBe(sessionId);
		expect(messages.filter((m) => m.role === "user").length).toBe(2);
		expect(messages.filter((m) => m.role === "assistant").length).toBe(2);
	});

	it("compacts and navigates the tree after a full turn", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const storage = await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), {
			cwd: dir,
			sessionId: "e2e-compact-1",
		});
		const session = new Session(storage);
		const faux = fauxProvider({ provider: "e2e-compact" });
		models.setProvider(faux.provider);
		faux.setResponses([
			() => fauxAssistantMessage("first reply"),
			() => fauxAssistantMessage("## Goal\nCompact summary"),
			() => fauxAssistantMessage("## Goal\nBranch summary"),
		]);

		const harness = new AgentHarness<{ env: NodeExecutionEnv }>({
			models,
			session,
			model: faux.getModel(),
			toolContext: { env },
		});
		const firstMessageId = await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now(),
		});
		await harness.prompt("first message");

		// Compaction runs against the persisted branch.
		const compactResult = await harness.compact();
		expect(compactResult).toBeDefined();
		const entries = await session.getEntries();
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);

		// Tree navigation back to the first user message.
		const navigateResult = await harness.navigateTree(firstMessageId, { summarize: true });
		expect(navigateResult.cancelled).toBe(false);
	});
});
