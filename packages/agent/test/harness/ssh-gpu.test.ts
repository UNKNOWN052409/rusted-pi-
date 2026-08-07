import { describe, expect, it, vi } from "vitest";
import { type SshExec, SshGpuRuntime } from "../../src/ssh-gpu-runtime.ts";

/**
 * SshGpuRuntime — the bridge that routes ALL tasks to a GPU box over SSH
 * (Google Colab or any GPU SSH host). These tests verify the runtime with an
 * injected exec (no real SSH client needed):
 *
 * 1. available() probes nvidia-smi and reports a GPU name.
 * 2. runRemote() forwards a command and returns trimmed stdout; non-zero
 *    exit codes surface as errors.
 * 3. The keepalive loop keeps the connection alive, tolerates transient
 *    misses, and declares a disconnect after consecutive failures.
 * 4. The ~30-minute session-end warning fires once and is not repeated.
 */

function makeExec(fn: (command: string) => { code: number; stdout: string; stderr: string }): SshExec {
	return async (command) => fn(command);
}

describe("SshGpuRuntime", () => {
	it("probes nvidia-smi and reports the GPU name", async () => {
		const exec = makeExec((command) =>
			command.includes("nvidia-smi")
				? { code: 0, stdout: "Tesla T4\n", stderr: "" }
				: { code: 0, stdout: "ok\n", stderr: "" },
		);
		const runtime = new SshGpuRuntime({ host: "nyc1.tmate.io", user: "x", exec });
		expect(await runtime.available()).toBe(true);
		expect(await runtime.name()).toBe("Tesla T4");
	});

	it("reports no GPU when nvidia-smi is absent", async () => {
		const exec = makeExec(() => ({ code: 1, stdout: "", stderr: "nvidia-smi: not found" }));
		const runtime = new SshGpuRuntime({ host: "box", exec });
		expect(await runtime.available()).toBe(false);
		expect(await runtime.name()).toBe("unknown");
	});

	it("forwards a remote command and returns trimmed stdout", async () => {
		const exec = makeExec((command) => {
			if (command.includes("uname -m")) return { code: 0, stdout: "aarch64\n", stderr: "" };
			return { code: 0, stdout: "ok\n", stderr: "" };
		});
		const runtime = new SshGpuRuntime({ host: "box", exec });
		expect(await runtime.runRemote("uname -m")).toBe("aarch64");
	});

	it("surfaces non-zero exit codes as errors", async () => {
		const exec = makeExec(() => ({ code: 2, stdout: "", stderr: "boom" }));
		const runtime = new SshGpuRuntime({ host: "box", exec });
		await expect(runtime.runRemote("false")).rejects.toThrow(/boom/);
	});

	it("keeps the connection alive, tolerates a transient miss, then declares disconnect", async () => {
		vi.useFakeTimers();
		try {
			let pings = 0;
			const onDisconnect = vi.fn();
			const exec = makeExec(() => {
				pings += 1;
				// Ping 1: connect. Ping 2: transient miss. Pings 3-5: down.
				if (pings === 2) return { code: 1, stdout: "", stderr: "timeout" };
				if (pings >= 3) return { code: 1, stdout: "", stderr: "down" };
				return { code: 0, stdout: "ok\n", stderr: "" };
			});
			const runtime = new SshGpuRuntime(
				{ host: "box", exec, pingIntervalMs: 100, maxMissedPings: 3 },
				{ onDisconnect },
			);
			expect(runtime.isConnected()).toBe(false);
			runtime.start();
			// Ping 1 connects.
			await vi.advanceTimersByTimeAsync(110);
			expect(runtime.isConnected()).toBe(true);
			// Ping 2 transiently misses: still connected.
			await vi.advanceTimersByTimeAsync(110);
			expect(runtime.isConnected()).toBe(true);
			// Pings 3, 4, 5 fail: three consecutive misses -> disconnect, once.
			await vi.advanceTimersByTimeAsync(400);
			expect(runtime.isConnected()).toBe(false);
			expect(onDisconnect).toHaveBeenCalledTimes(1);
			runtime.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("warns once ~30 minutes before the predicted session end", async () => {
		vi.useFakeTimers();
		try {
			const exec = makeExec(() => ({ code: 0, stdout: "ok\n", stderr: "" }));
			let lastInfo: { remainingMs: number } | undefined;
			const onWarning = vi.fn((info: { remainingMs: number }) => {
				lastInfo = info;
			});
			const runtime = new SshGpuRuntime(
				{
					host: "box",
					exec,
					pingIntervalMs: 100,
					sessionDurationMs: 60 * 60 * 1000, // 1h session
					warnBeforeMs: 30 * 60 * 1000, // warn at 30 min left
				},
				{ onWarning },
			);
			runtime.start();
			// Connect at t=0.
			await vi.advanceTimersByTimeAsync(110);
			// 35 minutes pass: elapsed > 30m, remaining < 30m -> warning.
			await vi.advanceTimersByTimeAsync(35 * 60 * 1000);
			expect(onWarning).toHaveBeenCalledTimes(1);
			const info = lastInfo!;
			expect(info.remainingMs).toBeLessThanOrEqual(30 * 60 * 1000);
			// Warning does not repeat on later pings.
			await vi.advanceTimersByTimeAsync(60 * 1000);
			expect(onWarning).toHaveBeenCalledTimes(1);
			runtime.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
