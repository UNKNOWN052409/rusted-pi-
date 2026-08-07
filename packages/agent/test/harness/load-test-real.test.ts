import { describe, expect, it } from "vitest";
import { type LoadTestOptions, readCpuUtil, readGpuUtil, runLoadTest } from "../../src/load-test.ts";

/** Stand-in GPU-heavy readers: 90% GPU, 5% CPU. */
function gpuHeavy(): LoadTestOptions {
	return {
		readGpuUtil: async () => 90,
		readCpuUtil: async () => 5,
		forceGpu: true,
	};
}

/** Simulated CPU-heavy readers: 5% GPU, 85% CPU. */
function cpuHeavy(): LoadTestOptions {
	return {
		readGpuUtil: async () => 5,
		readCpuUtil: async () => 85,
		forceGpu: true,
	};
}

/** Balanced readers: 50/50. */
function balanced(): LoadTestOptions {
	return {
		readGpuUtil: async () => 50,
		readCpuUtil: async () => 50,
		forceGpu: true,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("runLoadTest (GPU vs CPU classification)", () => {
	it("classifies a GPU-dominant task as gpu", async () => {
		const result = await runLoadTest(
			async () => {
				await sleep(60);
			},
			{ ...gpuHeavy(), sampleIntervalMs: 10 },
		);
		expect(result.dominant).toBe("gpu");
		expect(result.gpuPresent).toBe(true);
		expect(result.peakGpuUtil).toBe(90);
		expect(result.samples.length).toBeGreaterThanOrEqual(1);
	});

	it("classifies a CPU-dominant task as cpu", async () => {
		const result = await runLoadTest(
			async () => {
				await sleep(60);
			},
			{ ...cpuHeavy(), sampleIntervalMs: 10 },
		);
		expect(result.dominant).toBe("cpu");
		expect(result.peakCpuUtil).toBe(85);
	});

	it("classifies a balanced task as balanced", async () => {
		const result = await runLoadTest(
			async () => {
				await sleep(60);
			},
			{ ...balanced(), sampleIntervalMs: 10 },
		);
		expect(result.dominant).toBe("balanced");
	});

	it("reports cpu when no GPU is present (GPU util -1)", async () => {
		const result = await runLoadTest(
			async () => {
				await sleep(40);
			},
			{
				readGpuUtil: async () => -1,
				readCpuUtil: async () => 70,
				sampleIntervalMs: 10,
			},
		);
		expect(result.dominant).toBe("cpu");
		expect(result.gpuPresent).toBe(false);
		expect(result.peakGpuUtil).toBe(0);
	});

	it("produces at least one sample when the task finishes fast", async () => {
		const result = await runLoadTest(async () => {}, {
			readGpuUtil: async () => 10,
			readCpuUtil: async () => 10,
			forceGpu: true,
			sampleIntervalMs: 1000,
		});
		expect(result.samples.length).toBe(1);
	});

	it("real readCpuUtil returns a number in range on this machine", async () => {
		const util = await readCpuUtil();
		expect(util).toBeGreaterThanOrEqual(0);
		expect(util).toBeLessThanOrEqual(100);
	});

	it("real readGpuUtil returns -1 without a GPU or a number in range with one", async () => {
		const util = await readGpuUtil();
		if (util === -1) {
			// No GPU on this box — that's a valid outcome.
			expect(util).toBe(-1);
		} else {
			expect(util).toBeGreaterThanOrEqual(0);
			expect(util).toBeLessThanOrEqual(100);
		}
	});
});
