import { describe, expect, it } from "vitest";
import {
	A2ATaskLedger,
	AlertRuleEngine,
	type GuardrailContext,
	GuardrailEngine,
	type GuardrailResult,
} from "../../src/future-agi.ts";

// Real guardrail implementations: pure functions over real context values.
const blockIfContains =
	(needle: string) =>
	async (_name: string, ctx: GuardrailContext): Promise<GuardrailResult> => {
		const text = typeof ctx.input === "string" ? ctx.input : JSON.stringify(ctx.input);
		return {
			name: _name,
			action: text.includes(needle) ? "block" : "allow",
			blocked: text.includes(needle),
			reason: text.includes(needle) ? `input contains ${needle}` : "clean",
		};
	};

describe("future-agi GuardrailEngine", () => {
	it("short-circuits on the first blocking rule", async () => {
		const engine = new GuardrailEngine({
			rules: [
				{ name: "secrets", mode: "sync", action: "block" },
				{ name: "profanity", mode: "sync", action: "block" },
			],
			registry: new Map([
				["secrets", blockIfContains("API_KEY")],
				["profanity", blockIfContains("badword")],
			]),
		});
		const results = await engine.run({ input: "export const API_KEY = 'x';" });
		expect(results).toHaveLength(1); // profanity never ran
		expect(results[0]!.name).toBe("secrets");
		expect(results[0]!.blocked).toBe(true);
	});

	it("fails closed on unknown guardrails by default, open when configured", async () => {
		const engine = new GuardrailEngine({
			rules: [{ name: "missing", mode: "sync", action: "block" }],
			registry: new Map(),
		});
		const closed = await engine.run({ input: "anything" });
		expect(closed[0]!.blocked).toBe(true);

		const open = new GuardrailEngine({
			rules: [{ name: "missing", mode: "sync", action: "block" }],
			registry: new Map(),
			failOpen: true,
		});
		const opened = await open.run({ input: "anything" });
		expect(opened[0]!.blocked).toBe(false);
	});

	it("bounds async concurrency to maxAsync", async () => {
		let inFlight = 0;
		let peak = 0;
		const slow = async (_name: string, _ctx: GuardrailContext): Promise<GuardrailResult> => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight--;
			return { name: _name, action: "allow", blocked: false, reason: "slow check done" };
		};
		const engine = new GuardrailEngine({
			rules: [
				{ name: "a", mode: "async", action: "allow" },
				{ name: "b", mode: "async", action: "allow" },
				{ name: "c", mode: "async", action: "allow" },
				{ name: "d", mode: "async", action: "allow" },
				{ name: "e", mode: "async", action: "allow" },
				{ name: "f", mode: "async", action: "allow" },
			],
			registry: new Map([
				["a", slow],
				["b", slow],
				["c", slow],
				["d", slow],
				["e", slow],
				["f", slow],
			]),
			maxAsync: 2,
		});
		// Sequential rule iteration means each async guardrail awaits before
		// the next starts, so peak stays 1; this validates no unbounded fan-out.
		await engine.run({ input: "x" });
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe("future-agi A2A task ledger", () => {
	it("walks the full task lifecycle with validation", () => {
		const ledger = new A2ATaskLedger();
		const task = ledger.createTask("t1", "ctx-9", { source: "render-a" });
		expect(task.state).toBe("working");

		ledger.appendMessage("t1", "user", [{ kind: "text", text: "build the module" }]);
		ledger.addArtifact("t1", { name: "module.ts", parts: [{ kind: "text", text: "export const ok = 1;" }] });
		ledger.updateState("t1", "completed", "module built");

		const done = ledger.getTask("t1")!;
		expect(done.state).toBe("completed");
		expect(done.artifacts).toHaveLength(1);
		expect(done.history.map((m) => m.role)).toEqual(["user", "agent"]);
		expect(() => ledger.updateState("t1", "failed")).toThrow(/terminal state/);
	});

	it("rejects invalid states and unknown tasks", () => {
		const ledger = new A2ATaskLedger();
		ledger.createTask("t2");
		expect(() => ledger.updateState("t2", "bogus" as never)).toThrow(/invalid task state/);
		expect(ledger.getTask("nope")).toBeUndefined();
	});

	it("emits task events for status and artifacts", () => {
		const ledger = new A2ATaskLedger();
		const task = ledger.createTask("t3");
		const events = ledger.events(task);
		expect(events[0]!.type).toBe("task/status-update");
		ledger.addArtifact("t3", { parts: [{ kind: "file", uri: "a2a://t3/out.json", mimeType: "application/json" }] });
		const withArtifact = ledger.events(ledger.getTask("t3")!);
		expect(withArtifact.some((e) => e.type === "task/artifact-update")).toBe(true);
	});
});

describe("future-agi sliding-window alert rule", () => {
	it("fires when the windowed average crosses the threshold", () => {
		let t = 0;
		const rule = new AlertRuleEngine(
			{
				name: "latency",
				metric: "p95",
				condition: "gte",
				threshold: 100,
				windowMs: 1000,
				cooldownMs: 500,
				channels: ["telegram"],
			},
			() => t,
		);
		expect(rule.observe(50)).toBeUndefined();
		t = 100;
		expect(rule.observe(50)).toBeUndefined();
		t = 200;
		// avg (50+50+200)/3 = 100 >= 100
		const fired = rule.observe(200);
		expect(fired).toBeDefined();
		expect(fired!.metric).toBe("p95");
		expect(fired!.channels).toContain("telegram");
	});

	it("honors the cooldown window and sliding expiry", () => {
		let t = 0;
		const rule = new AlertRuleEngine(
			{
				name: "errs",
				metric: "error_rate",
				condition: "gte",
				threshold: 10,
				windowMs: 500,
				cooldownMs: 1000,
				channels: ["web"],
			},
			() => t,
		);
		t = 0;
		rule.observe(20); // fires
		t = 100;
		expect(rule.observe(30)).toBeUndefined(); // still inside cooldown
		t = 1100;
		const fired = rule.observe(30);
		expect(fired).toBeDefined();
		// Old values (t=0) expired out of the 500ms window; only t=1100 counts.
		expect(fired!.value).toBe(30);
	});
});
