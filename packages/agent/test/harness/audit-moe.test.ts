import { describe, expect, it } from "vitest";
import {
	AGENT_STATE_MB,
	CORE_PER_WAKE,
	computeMoeBudget,
	MIN_RESERVE_MB,
	MIN_WAKE_SLOTS,
	MoeBudgetExhaustedError,
	MoeScheduler,
} from "../../src/harness/tools/moe-tools.ts";

describe("MoE budget: 100 terminals on low-end hardware", () => {
	it("1 core / 2 GB hosts 100+ terminals (the design target)", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 1, memLimitMB: 2048 });
		// CPU: 1 core / 0.1 core-per-wake = 10 concurrent wakes.
		expect(budget.wakeParallelism).toBe(10);
		// RAM: (2048 - 256) / 16 = 112 sleeping state slots.
		expect(budget.stateSlots).toBe(112);
		// Burst factor makes the wake side non-limiting; state bounds capacity.
		expect(budget.terminalCapacity).toBeGreaterThanOrEqual(100);
		expect(budget.supportsHundredTerminals).toBe(true);
	});

	it("Realme C15 (8 core / 3-4 GB) hosts 100+ terminals", () => {
		for (const memLimitMB of [3072, 4096]) {
			const budget = computeMoeBudget({ cpuQuotaCores: 8, memLimitMB });
			expect(budget.wakeParallelism).toBe(80);
			expect(budget.supportsHundredTerminals).toBe(true);
		}
	});

	it("even >0.1 core gets a full wake slot (the MoE promise)", () => {
		const fractional = computeMoeBudget({ cpuQuotaCores: 0.1, memLimitMB: 512 });
		expect(fractional.wakeParallelism).toBe(MIN_WAKE_SLOTS);
		// (512 - 256) / 16 = 16 sleeping slots; still does full work serially.
		expect(fractional.stateSlots).toBe(16);
		expect(fractional.terminalCapacity).toBeGreaterThanOrEqual(1);
	});

	it("budget math is derived from the constants", () => {
		const budget = computeMoeBudget({ cpuQuotaCores: 2, memLimitMB: 1024 });
		expect(budget.wakeParallelism).toBe(Math.floor(2 / CORE_PER_WAKE));
		expect(budget.stateSlots).toBe(Math.floor((1024 - MIN_RESERVE_MB) / AGENT_STATE_MB));
	});
});

describe("MoE scheduler: lazy activation (agents asleep until needed)", () => {
	it("registers 100 agents as cheap state and wakes them one at a time", async () => {
		const scheduler = new MoeScheduler({ cpuQuotaCores: 1, memLimitMB: 2048 });
		for (let i = 0; i < 100; i++) {
			scheduler.register(`agent-${i}`, i === 42 ? "serialized-session" : undefined);
		}
		expect(scheduler.sleepingCount).toBe(100);
		expect(scheduler.activeCountNow).toBe(0);

		// Waking a fresh agent yields no restored state.
		const fresh = await scheduler.wake("agent-0");
		expect(fresh).toBeUndefined();
		expect(scheduler.activeCountNow).toBe(1);

		// Waking the one with a checkpoint restores it.
		const restored = await scheduler.wake("agent-42");
		expect(restored).toBe("serialized-session");

		// Sleep releases the slot and persists latest state.
		await scheduler.sleep("agent-0", "new-state");
		expect(scheduler.activeCountNow).toBe(1);
		const again = await scheduler.wake("agent-0");
		expect(again).toBe("new-state");
	});

	it("rejects wakes beyond the CPU concurrency budget (queue and retry)", async () => {
		const scheduler = new MoeScheduler({ cpuQuotaCores: 0.2, memLimitMB: 1024 });
		for (let i = 0; i < 3; i++) scheduler.register(`agent-${i}`);
		await scheduler.wake("agent-0");
		await scheduler.wake("agent-1");
		await expect(scheduler.wake("agent-2")).rejects.toBeInstanceOf(MoeBudgetExhaustedError);

		await scheduler.sleep("agent-0");
		await expect(scheduler.wake("agent-2")).resolves.toBeUndefined();
	});

	it("unknown agent id throws", async () => {
		const scheduler = new MoeScheduler({ cpuQuotaCores: 1, memLimitMB: 1024 });
		await expect(scheduler.wake("missing")).rejects.toThrow('Unknown agent "missing"');
	});
});
