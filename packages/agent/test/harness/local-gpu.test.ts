import { describe, expect, it, vi } from "vitest";
import { type ExecFn, LocalGpuRuntime } from "../../src/local-gpu-runtime.ts";

/**
 * LocalGpuRuntime — routes compute to the device's own GPU (e.g. an NVIDIA
 * RTX 2050) via nvidia-smi detection + a torch CUDA kernel subprocess. These
 * tests verify detection, kernel routing, and failure handling with an
 * injected exec (no real GPU needed).
 */

function makeExec(fn: (command: string) => { code: number; stdout: string; stderr: string }): ExecFn {
	return async (command) => fn(command);
}

describe("LocalGpuRuntime", () => {
	it("detects the local GPU via nvidia-smi and reports its name", async () => {
		const exec = makeExec((command) =>
			command.includes("nvidia-smi")
				? { code: 0, stdout: "NVIDIA GeForce RTX 2050\n", stderr: "" }
				: { code: 0, stdout: "", stderr: "" },
		);
		const runtime = new LocalGpuRuntime({ exec });
		expect(await runtime.available()).toBe(true);
		expect(await runtime.name()).toBe("NVIDIA GeForce RTX 2050");
	});

	it("reports no GPU when nvidia-smi is absent", async () => {
		const exec = makeExec(() => ({ code: 1, stdout: "", stderr: "nvidia-smi: not found" }));
		const runtime = new LocalGpuRuntime({ exec });
		expect(await runtime.available()).toBe(false);
		expect(await runtime.name()).toBe("unknown");
	});

	it("routes a kernel to CUDA:0 and returns stdout", async () => {
		const exec = makeExec((command) =>
			command.includes("python") && command.includes(".py")
				? { code: 0, stdout: "GPU: NVIDIA GeForce RTX 2050\nRESULT: 42.0\n", stderr: "" }
				: { code: 1, stdout: "", stderr: "unexpected command" },
		);
		const runtime = new LocalGpuRuntime({ exec });
		const output = await runtime.runKernel("print('RESULT: 42.0')");
		expect(output).toContain("GPU: NVIDIA GeForce RTX 2050");
		expect(output).toContain("RESULT: 42.0");
	});

	it("surfaces kernel failures as errors", async () => {
		const exec = makeExec(() => ({ code: 1, stdout: "", stderr: "CUDA out of memory" }));
		const runtime = new LocalGpuRuntime({ exec });
		await expect(runtime.runKernel("print('x')")).rejects.toThrow(/CUDA out of memory/);
	});

	it("uses the injectable python path in the command", async () => {
		const exec = vi.fn(async (command: string) => {
			expect(command).toContain("C:/python312/python.exe");
			expect(command).toMatch(/\.py$/);
			return { code: 0, stdout: "GPU: x\nok\n", stderr: "" };
		});
		const runtime = new LocalGpuRuntime({ python: "C:/python312/python.exe", exec });
		await runtime.runKernel("print('ok')");
		expect(exec).toHaveBeenCalled();
	});
});
