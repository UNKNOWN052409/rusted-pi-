import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GpuDispatcher, RustGpuRuntime } from "../../src/gpu-dispatcher.ts";
import { piNativeBinaryPath, RustBridge, type RustGpuInfo, type RustStabilityResult } from "../../src/rust-bridge.ts";

/** Runs the real binary as a one-shot script — used for live tests. */
function runRealScript(script: string): string {
	const binary = piNativeBinaryPath();
	if (!binary) throw new Error("pi-native binary not found");
	const result = spawnSync(binary, [], { input: script, encoding: "utf8", timeout: 20_000 });
	if (result.error) throw result.error;
	return result.stdout ?? "";
}

describe("RustBridge: pi-native wiring", () => {
	it("resolves the pi-native binary path (or cleanly reports absence)", () => {
		// The binary exists on this repo layout after `cargo build --release`;
		// fresh checkouts without it must still get null, never a throw.
		const path = piNativeBinaryPath();
		if (path) {
			expect(existsSync(path)).toBe(true);
			expect(path).toContain("pi-native");
		} else {
			expect(path).toBeNull();
		}
	});

	it("parses GPU info through the injected runner", async () => {
		const gpu: RustGpuInfo = {
			available: true,
			name: "NVIDIA GeForce RTX 2050",
			vramMb: 4095,
			computeCapability: 6.1,
			smCount: 0,
			isWddm: true,
		};
		const bridge = new RustBridge({ runScript: async () => `${JSON.stringify(gpu)}\n` });
		expect(await bridge.detectGpu()).toEqual(gpu);
	});

	it("degrades to a no-GPU shape when the runner fails", async () => {
		const bridge = new RustBridge({
			runScript: async () => {
				throw new Error("binary missing");
			},
		});
		expect(await bridge.detectGpu()).toEqual({
			available: false,
			name: "",
			vramMb: 0,
			computeCapability: 0,
			smCount: 0,
			isWddm: false,
		});
	});

	it("passes CPU threshold through to shouldYield", async () => {
		const bridge = new RustBridge({
			runScript: async () => `${JSON.stringify({ load: 0.9, coreCount: 16, shouldYield: true })}\n`,
		});
		expect((await bridge.cpuLoad()).shouldYield).toBe(true);
		expect((await bridge.cpuLoad(0.95)).shouldYield).toBe(false);
	});

	it("maps stability-check verdicts", async () => {
		const verdict: RustStabilityResult = {
			pass: false,
			issues: [{ type: "fake_model", severity: "error", detail: "gpt-5 is fabricated" }],
			suggestedAction: "reject",
			source: "rust",
		};
		const bridge = new RustBridge({ runScript: async () => `${JSON.stringify(verdict)}\n` });
		const result = await bridge.stabilityCheck("hello", "gpt-5");
		expect(result.pass).toBe(false);
		expect(result.suggestedAction).toBe("reject");
		expect(result.issues[0]?.type).toBe("fake_model");
	});

	it("detects api format and compaction verdicts via injected runner", async () => {
		const bridge = new RustBridge({
			runScript: async (script) => {
				if (script.startsWith("detect-api")) {
					return `${JSON.stringify({
						api: "openai-responses",
						confidence: 0.9,
						providerName: "OpenAI Compatible",
						isKnownProvider: true,
					})}\n`;
				}
				return `${JSON.stringify({ shouldCompact: true, reason: "reserve reached" })}\n`;
			},
		});
		expect((await bridge.detectApi("https://api.openai.com/v1")).api).toBe("openai-responses");
		expect((await bridge.shouldCompact(120_000, 128_000)).shouldCompact).toBe(true);
	});

	it("RustGpuRuntime reports availability through the bridge", async () => {
		const bridge = new RustBridge({
			runScript: async () =>
				`${JSON.stringify({
					available: true,
					name: "Tesla T4",
					vramMb: 15_360,
					computeCapability: 7.5,
					smCount: 40,
					isWddm: false,
				})}\n`,
		});
		const runtime = new RustGpuRuntime(bridge);
		expect(await runtime.available()).toBe(true);
		expect(await runtime.name()).toBe("Tesla T4");
	});

	it("feeds the GpuDispatcher mode from the Rust probed GPU", async () => {
		const bridge = new RustBridge({
			runScript: async () =>
				JSON.stringify({ available: false, name: "", vramMb: 0, computeCapability: 0, smCount: 0, isWddm: false }) +
				"\n",
		});
		const dispatcher = new GpuDispatcher({ runtime: new RustGpuRuntime(bridge) });
		expect(await dispatcher.detect()).toBe("cpu");
	});
});

describe.skipIf(!piNativeBinaryPath())("RustBridge: live pi-native binary", () => {
	it("runs detect-gpu / cpu-load / system-memory against the real binary", async () => {
		const out = runRealScript("detect-gpu\nsystem-memory\nexit\n");
		const [gpuLine, memLine] = out.trim().split(/\r?\n/);
		const gpu = JSON.parse(gpuLine ?? "") as RustGpuInfo;
		expect(typeof gpu.available).toBe("boolean");
		if (gpu.available) expect(gpu.name.length).toBeGreaterThan(0);
		const mem = JSON.parse(memLine ?? "") as { totalMb: number };
		expect(mem.totalMb).toBeGreaterThan(0);
	});

	it("flags a fabricated model through the real stability-check", async () => {
		const out = runRealScript('stability-check {"text":"hello","modelId":"gpt-5"}\nexit\n');
		const verdict = JSON.parse(out.trim().split(/\r?\n/)[0] ?? "") as RustStabilityResult;
		expect(verdict.pass).toBe(false);
		expect(verdict.source).toBe("rust");
		expect(verdict.suggestedAction).toBe("reject");
	});

	it("detects the API format for api.openai.com through the real binary", async () => {
		const out = runRealScript('detect-api {"url":"https://api.openai.com/v1"}\nexit\n');
		const detection = JSON.parse(out.trim().split(/\r?\n/)[0] ?? "") as { api: string; confidence: number };
		expect(detection.api).toBe("openai-responses");
		expect(detection.confidence).toBeGreaterThanOrEqual(0.6);
	});

	it("compacts on reserve overflow and reports usage percent (real binary)", async () => {
		const out = runRealScript(
			'compaction-should-compact {"contextTokens":120000,"contextWindow":128000,"reserveTokens":100000}\nexit\n',
		);
		const verdict = JSON.parse(out.trim().split(/\r?\n/)[0] ?? "") as {
			shouldCompact: boolean;
			thresholdHit: string | null;
			usagePercent: number;
		};
		expect(verdict.shouldCompact).toBe(true);
		expect(verdict.thresholdHit).toBe("reserve");
		expect(verdict.usagePercent).toBeGreaterThan(0.8);
	});

	it("shares one subprocess across concurrent bridge calls without interleaving", async () => {
		const bridge = new RustBridge();
		const [gpu, mem, cpu] = await Promise.all([bridge.detectGpu(), bridge.systemMemoryMb(), bridge.cpuLoad()]);
		// Distinct shapes prove responses did not cross wires.
		expect(typeof gpu.available).toBe("boolean");
		expect(mem).toBeGreaterThan(0);
		expect(cpu.coreCount).toBeGreaterThan(0);
		bridge.shutdown();
	});

	it("end-to-end: GpuDispatcher with RustGpuRuntime matches the real hardware", async () => {
		const bridge = new RustBridge();
		const dispatcher = new GpuDispatcher({ runtime: new RustGpuRuntime(bridge) });
		const mode = await dispatcher.detect();
		const gpuName = await new RustGpuRuntime(bridge).name();
		// On this dev box (RTX 2050) mode must be "gpu"; other machines fall back.
		if (mode === "gpu") {
			expect(gpuName).not.toBe("unknown");
			expect(gpuName.toLowerCase()).toContain("nvidia");
		} else {
			expect(gpuName).toBe("unknown");
		}
		bridge.shutdown();
	});
});
