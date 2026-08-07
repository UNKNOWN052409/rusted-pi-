import { describe, expect, it } from "vitest";
import { GpuDispatcher } from "../../src/gpu-dispatcher.ts";
import { makeIsolatedTask, runIsolatedCommand } from "../../src/isolated-executor.ts";

describe("isolated-executor", () => {
	it("runs a real shell command through the shell-capable backend", async () => {
		const res = await runIsolatedCommand(["echo", "hello-iso"]);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain("hello-iso");
		expect(["subprocess", "unshare", "podman"]).toContain(res.backend);
		expect(res.timedOut).toBe(false);
		expect(res.wallMs).toBeGreaterThanOrEqual(0);
	});

	it("respects timeout on a hanging command", async () => {
		const res = await runIsolatedCommand(["sleep", "5"], { timeoutMs: 500 });
		expect(res.timedOut).toBe(true);
	});

	it("makeIsolatedTask produces a task runnable through GpuDispatcher.runAll", async () => {
		const task1 = makeIsolatedTask("t1", ["echo", "alpha"], { label: "a" });
		const task2 = makeIsolatedTask("t2", ["echo", "beta"], { label: "b" });
		const task3 = makeIsolatedTask("t3", ["echo", "gamma"], { label: "c" });
		const dispatcher = new GpuDispatcher({ concurrency: 2 });
		const results = await dispatcher.runAll([task1, task2, task3]);
		expect(results).toHaveLength(3);
		const byId = new Map(results.map((r) => [r.id, r]));
		expect(byId.get("t1")!.status).toBe("succeeded");
		expect(byId.get("t1")!.value!.stdout).toContain("alpha");
		expect(byId.get("t2")!.value!.stdout).toContain("beta");
		expect(byId.get("t3")!.value!.stdout).toContain("gamma");
		expect(dispatcher.outstanding).toBe(0);
	});

	it("reports the actual backend used on every result", async () => {
		const res = await runIsolatedCommand(["printf", "backend-check"]);
		expect(res.backend).toBeTruthy();
	});
});
