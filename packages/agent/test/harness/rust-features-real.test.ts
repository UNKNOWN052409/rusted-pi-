import { describe, expect, it } from "vitest";
import { createConnector } from "../../src/connectors.ts";
import { Doctor, type DoctorCheck } from "../../src/doctor.ts";
import { effortProfile, parseEffortLevel } from "../../src/effort-levels.ts";
import { ProgressTracker } from "../../src/progress.ts";
import { SwarmCoordinator } from "../../src/swarm.ts";
import { rankTools, routeTask, scoreTask, type ToolCapability } from "../../src/tool-router.ts";
import { TrustLedger } from "../../src/trust-ledger.ts";

describe("effort-levels", () => {
	it("parses valid levels and rejects unknown", () => {
		expect(parseEffortLevel("xhigh")).toBe("xhigh");
		expect(() => parseEffortLevel("ultra")).toThrow(/Unknown effort level/);
	});

	it("scales concurrency from minimum to xhigh", () => {
		expect(effortProfile("minimum").toolConcurrency).toBe(2);
		expect(effortProfile("xhigh").toolConcurrency).toBe(10);
		expect(effortProfile("low").swarm).toBe(false);
		expect(effortProfile("high").swarm).toBe(true);
	});
});

const caps: ToolCapability[] = [
	{ name: "bash", description: "run commands", keywords: ["run", "build", "test", "install"], weight: 1 },
	{ name: "read", description: "read files", keywords: ["read", "file", "view", "show"], weight: 1 },
	{ name: "edit", description: "edit files", keywords: ["edit", "change", "modify", "fix"], weight: 1 },
];

describe("tool-router", () => {
	it("scores by keyword overlap", () => {
		expect(scoreTask("please read the file", caps[1]!)).toBe(2);
		expect(scoreTask("run the build", caps[0]!)).toBe(2);
		expect(scoreTask("nothing relevant", caps[2]!)).toBe(0);
	});

	it("ranks best tool first", () => {
		const result = rankTools("run the build please", caps);
		expect(result.best).toBe("bash");
		expect(result.tools[0]).toBe("bash");
	});

	it("routeTask returns empty best when nothing matches", async () => {
		const result = await routeTask("zzz nothing matches", caps);
		expect(result.best).toBe("");
		expect(result.tools).toEqual([]);
	});

	it("applies an LLM refinement hook", async () => {
		const result = await routeTask("read the file", caps, {
			refine: async () => ["edit"],
		});
		expect(result.best).toBe("edit");
	});
});

describe("swarm", () => {
	it("runs tasks once each, no duplication", async () => {
		const coordinator = new SwarmCoordinator({ workers: 4, effort: "high" });
		let runs = 0;
		const tasks = [1, 2, 3, 4].map((n) => ({
			id: `t${n}`,
			run: async () => {
				runs += 1;
				return n * 2;
			},
		}));
		const out = await coordinator.runSwarm(tasks);
		expect(runs).toBe(4);
		expect(out.results.get("t1")).toEqual({ value: 2, ok: true });
		expect(out.results.get("t4")).toEqual({ value: 8, ok: true });
		expect(out.workerCount).toBe(4);
	});

	it("emits coordination events and tracks failures", async () => {
		const events: string[] = [];
		const coordinator = new SwarmCoordinator({
			workers: 2,
			onEvent: (e) => events.push(`${e.kind}:${e.taskId ?? "x"}`),
		});
		const out = await coordinator.runSwarm([
			{ id: "ok", run: async () => "y" },
			{ id: "bad", run: async () => Promise.reject(new Error("boom")) },
		]);
		expect(events).toContain("assigned:ok");
		expect(events).toContain("failed:bad");
		expect(out.results.get("bad")).toEqual({ error: "boom", ok: false });
	});

	it("gpu flag true when probe says so", async () => {
		const coordinator = new SwarmCoordinator({ gpuAvailable: async () => true });
		const out = await coordinator.runSwarm([{ id: "a", run: async () => 1 }]);
		expect(out.gpu).toBe(true);
	});
});

describe("progress", () => {
	it("clamps 0-100 and records history", () => {
		const tracker = new ProgressTracker({ consoleLog: false });
		tracker.report(150, "too much", "phase");
		tracker.report(-5, "negative", "phase");
		expect(tracker.latest).toBe(0);
		expect(tracker.history()[0]!.progress).toBe(100);
		expect(tracker.statusLine()).toContain("0%");
	});

	it("never crashes on throwing sync sink", () => {
		const tracker = new ProgressTracker({
			consoleLog: false,
			sinks: [
				{
					emit: () => {
						throw new Error("sink down");
					},
				},
			],
		});
		expect(() => tracker.report(50, "ok")).not.toThrow();
		expect(tracker.latest).toBe(50);
	});
});

describe("connectors", () => {
	it("telegram without token is inert", async () => {
		const c = createConnector({ kind: "telegram", name: "tg" });
		expect(c.enabled).toBe(false);
		await expect(c.send("hi")).resolves.toBeUndefined();
	});

	it("webhook without endpoint is inert", async () => {
		const c = createConnector({ kind: "webhook", name: "hook" });
		expect(c.enabled).toBe(false);
		await expect(c.send({ x: 1 })).resolves.toBeUndefined();
	});

	it("device-app requires token and endpoint", async () => {
		const c = createConnector({ kind: "device-app", name: "honeygain" });
		expect(c.enabled).toBe(false);
		await expect(c.send({})).resolves.toBeUndefined();
	});
});

describe("doctor/self-healing", () => {
	it("dry-run reports flaws but never fixes", async () => {
		let fixed = false;
		const doctor = new Doctor({ dryRun: true });
		const checks: DoctorCheck[] = [
			{
				name: "check-a",
				run: async () => true,
				fix: async () => {
					fixed = true;
					return true;
				},
			},
		];
		const out = await doctor.runAll(checks);
		expect(out.diagnoses[0]!.status).toBe("skipped-dry");
		expect(fixed).toBe(false);
	});

	it("applies fix when trusted and not dry-run, scores ledger", async () => {
		const ledger = new TrustLedger();
		const doctor = new Doctor({ dryRun: false, trustGate: 50, trust: ledger });
		const checks: DoctorCheck[] = [
			{
				name: "check-b",
				run: async () => true,
				fix: async () => true,
			},
		];
		const out = await doctor.runAll(checks);
		expect(out.diagnoses[0]!.status).toBe("fixed");
		expect(ledger.score("coder")).toBe(100); // clamped at cap
	});

	it("skips fix when trust below gate", async () => {
		const ledger = new TrustLedger();
		ledger.record("coder", "wrong", "repeated mistakes");
		const doctor = new Doctor({ dryRun: false, trustGate: 50, trust: ledger });
		const checks: DoctorCheck[] = [
			{
				name: "flaw",
				run: async () => true,
				fix: async () => true,
			},
		];
		const out = await doctor.runAll(checks);
		expect(out.diagnoses[0]!.status).toBe("flaw");
		expect(out.diagnoses[0]!.message).toContain("trust below gate");
	});
});
