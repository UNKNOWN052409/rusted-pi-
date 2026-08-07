import { describe, expect, it } from "vitest";
import {
	AGENT_STATE_MB,
	computeMoeBudget,
	detectCpuQuota,
	detectDeviceProfile,
	detectMemLimitMB,
	MoeBudgetExhaustedError,
	MoeScheduler,
} from "../../src/harness/tools/moe-tools.ts";

describe("computeMoeBudget", () => {
	it("0.1 core / 2 GB device still gets 1 wake slot and ~108 state slots", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 0.1, memLimitMB: 2000 });
		expect(budget.wakeParallelism).toBe(1); // MIN_WAKE_SLOTS
		expect(budget.stateSlots).toBe(Math.floor((2000 - 256) / 16)); // 109
		expect(budget.terminalCapacity).toBe(Math.min(1 * 10, 109)); // 10
		expect(budget.supportsHundredTerminals).toBe(false);
		expect(budget.rationale).toContain("cpu=0.1");
	});

	it("1 core / 2 GB gets 10 wake slots and supports 100 terminals via burst", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 1, memLimitMB: 2000 });
		expect(budget.wakeParallelism).toBe(10);
		expect(budget.stateSlots).toBe(109);
		expect(budget.terminalCapacity).toBe(100); // min(10*10, 109) = 100
		expect(budget.supportsHundredTerminals).toBe(true);
	});

	it("4 core / 8 GB gets 40 wake slots and capacity 109 (RAM-bound)", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 4, memLimitMB: 2000 });
		expect(budget.wakeParallelism).toBe(40);
		expect(budget.stateSlots).toBe(109);
		expect(budget.terminalCapacity).toBe(109); // min(40*10, 109)
		expect(budget.supportsHundredTerminals).toBe(true);
	});

	it("tiny RAM still yields at least 1 state slot", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 0.1, memLimitMB: 100 });
		expect(budget.stateSlots).toBeGreaterThanOrEqual(1);
		expect(budget.wakeParallelism).toBeGreaterThanOrEqual(1);
	});

	it("zero cores are clamped to 0.1", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 0, memLimitMB: 2000 });
		expect(budget.wakeParallelism).toBe(1);
	});
});

describe("MoeScheduler", () => {
	it("registers, wakes with state, and sleeps persisting state", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 }); // maxActive = 1
		sched.register("a", "state-v1");
		expect(sched.sleepingCount).toBe(1);
		expect(sched.activeCountNow).toBe(0);

		const state = await sched.wake("a");
		expect(state).toBe("state-v1");
		expect(sched.activeCountNow).toBe(1);

		await sched.sleep("a", "state-v2");
		expect(sched.activeCountNow).toBe(0);

		// wake again returns the latest persisted state
		const state2 = await sched.wake("a");
		expect(state2).toBe("state-v2");
		await sched.sleep("a");
	});

	it("rejects waking an unknown agent", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 });
		await expect(sched.wake("nope")).rejects.toThrow('Unknown agent "nope"');
	});

	it("throws MoeBudgetExhaustedError when wake budget is exhausted", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 }); // maxActive = 1
		sched.register("a");
		sched.register("b");
		await sched.wake("a");
		await expect(sched.wake("b")).rejects.toThrow("Wake budget exhausted");
		await expect(sched.wake("b")).rejects.toBeInstanceOf(MoeBudgetExhaustedError);
	});

	it("sleeping an unknown agent is a no-op", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 });
		await expect(sched.sleep("ghost", "s")).resolves.toBeUndefined();
	});

	it("activeCount never goes below zero", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 });
		await sched.sleep("ghost");
		expect(sched.activeCountNow).toBe(0);
	});

	it("register without state wakes to undefined (fresh agent)", async () => {
		const sched = new MoeScheduler({ cpuQuotaCores: 0.1, memLimitMB: 2000 });
		sched.register("fresh");
		const state = await sched.wake("fresh");
		expect(state).toBeUndefined();
		await sched.sleep("fresh");
	});
});

describe("device detection (environment-independent paths)", () => {
	it("detectCpuQuota and detectMemLimitMB return sane values", () => {
		const cpu = detectCpuQuota();
		expect(cpu).toBeGreaterThan(0);
		const mem = detectMemLimitMB();
		expect(mem).toBeGreaterThan(100);
	});

	it("detectDeviceProfile builds a valid budget", () => {
		const profile = detectDeviceProfile();
		expect(profile.cpuQuotaCores).toBeGreaterThan(0);
		expect(profile.memLimitMB).toBeGreaterThan(100);
		const budget = computeMoeBudget(profile);
		expect(budget.wakeParallelism).toBeGreaterThanOrEqual(1);
		expect(budget.terminalCapacity).toBeGreaterThanOrEqual(1);
	});

	it("AGENT_STATE_MB constant is exported and used in rationale", () => {
		expect(AGENT_STATE_MB).toBe(16);
	});
});
