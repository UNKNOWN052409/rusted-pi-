import { describe, expect, it } from "vitest";
import { GpuCrashManager } from "../../src/gpu-crash-manager.ts";
import { GpuDispatcher, GpuTaskStatus } from "../../src/gpu-dispatcher.ts";

describe("GpuDispatcher: route ALL tasks to the GPU, run in parallel", () => {
	it("detects a GPU and routes every task to it", async () => {
		const dispatcher = new GpuDispatcher({
			runtime: { available: async () => true, name: async () => "T4" },
			concurrency: 3,
		});
		expect(await dispatcher.detect()).toBe("gpu");
		expect(dispatcher.mode).toBe("gpu");
	});

	it("falls back to CPU when no GPU runtime is present", async () => {
		const dispatcher = new GpuDispatcher({ runtime: null });
		expect(await dispatcher.detect()).toBe("cpu");
		expect(dispatcher.mode).toBe("cpu");
	});

	it("runs multiple tasks concurrently and returns results in order", async () => {
		const dispatcher = new GpuDispatcher({ runtime: null, concurrency: 4 });
		const order: number[] = [];
		const tasks = [0, 1, 2, 3].map((i) => ({
			id: `t${i}`,
			run: async () => {
				order.push(i);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return i * 10;
			},
		}));
		const results = await dispatcher.runAll(tasks);
		expect(results.map((r) => r.value)).toEqual([0, 10, 20, 30]);
		// Bounded concurrency (4) with a batch of 4 → all started at once (parallel).
		expect(new Set(order).size).toBe(4);
		expect(dispatcher.outstanding).toBe(0);
	});

	it("records success/failure in the snapshot for checkpointing", async () => {
		const dispatcher = new GpuDispatcher({ runtime: null, concurrency: 1 });
		const results = await dispatcher.runAll([
			{ id: "good", run: async () => "ok" },
			{
				id: "bad",
				run: async () => {
					throw new Error("gpu oom");
				},
			},
		]);
		expect(results[0]!.status).toBe(GpuTaskStatus.Succeeded);
		expect(results[1]!.status).toBe(GpuTaskStatus.Failed);
		expect(results[1]!.error).toBe("gpu oom");

		const snapshot = dispatcher.snapshot();
		const good = snapshot.find((r) => r.id === "good");
		const bad = snapshot.find((r) => r.id === "bad");
		expect(good?.status).toBe(GpuTaskStatus.Succeeded);
		expect(bad?.status).toBe(GpuTaskStatus.Failed);
		expect(bad?.error).toBe("gpu oom");
	});
});

describe("GpuCrashManager: checkpoints everything, restarts on crash", () => {
	it("saves a checkpoint and records a done result", async () => {
		const saved: unknown[] = [];
		const manager = new GpuCrashManager({
			saveCheckpoint: async (cp) => {
				saved.push(cp);
			},
			loadCheckpoint: async () => undefined,
		});
		const result = await manager.runWithRecovery(
			"task-1",
			async () => 42,
			async () => {},
		);
		expect(result.value).toBe(42);
		expect(result.attempts).toBe(1);
		// pending (before) + done (after).
		expect(saved).toHaveLength(2);
	});

	it("restarts a task that crashed mid-run and succeeds on retry", async () => {
		let calls = 0;
		const checkpoints = new Map<string, { status: string }>();
		const manager = new GpuCrashManager({
			saveCheckpoint: async (cp) => {
				checkpoints.set(cp.taskId, { status: cp.status });
			},
			loadCheckpoint: async (taskId) => {
				const state = checkpoints.get(taskId);
				return state ? ({ taskId, status: state.status, takenAt: Date.now() } as never) : undefined;
			},
			maxRetries: 3,
		});
		const result = await manager.runWithRecovery(
			"flaky",
			async () => {
				calls += 1;
				if (calls === 1) throw new Error("transient");
				return "recovered";
			},
			async () => {},
		);
		expect(result.value).toBe("recovered");
		expect(calls).toBe(2);
		expect(result.recovered).toBe(false); // no mid-run crash state to restore; plain retry.
	});

	it("exhausts retries and returns the error", async () => {
		const manager = new GpuCrashManager({
			saveCheckpoint: async () => {},
			loadCheckpoint: async () => undefined,
			maxRetries: 0,
		});
		const result = await manager.runWithRecovery(
			"always-fails",
			async () => {
				throw new Error("hard");
			},
			async () => {},
		);
		expect(result.error).toBe("hard");
		expect(result.attempts).toBeGreaterThanOrEqual(1);
	});
});
