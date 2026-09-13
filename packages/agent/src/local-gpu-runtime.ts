/**
 * Local GPU runtime.
 *
 * Detects a local NVIDIA GPU (nvidia-smi) and routes compute tasks to it via
 * CUDA/PyTorch. Used when there is no remote GPU box — the device itself
 * (e.g. this Windows dev machine with an RTX 2050) carries the GPU work.
 *
 * Task routing model: the dispatcher calls {@link runKernel} with a GPU task;
 * we execute it as a Python + torch CUDA subprocess so the matrix work
 * actually lands on GPU silicon. All subprocess execution goes through an
 * injected `exec` so tests run without a real GPU.
 */

import { exec } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a shell command, returns its result. */
export type ExecFn = (command: string, timeoutMs?: number) => Promise<ExecResult>;

/** Default executor using node:child_process exec with a shell. */
async function defaultExec(command: string, timeoutMs = 120_000): Promise<ExecResult> {
	return new Promise((resolve) => {
		exec(command, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

export interface LocalGpuRuntimeOptions {
	/** Path to the python interpreter that has torch+cuda (default "python"). */
	python?: string;
	/** Timeout for GPU kernels (default 120s). */
	kernelTimeoutMs?: number;
	/** Injectable executor for tests. */
	exec?: ExecFn;
}

export class LocalGpuRuntime {
	private readonly python: string;
	private readonly kernelTimeoutMs: number;
	private readonly execImpl: ExecFn;
	private probed = false;
	private gpuName: string | null = null;

	constructor(options: LocalGpuRuntimeOptions = {}) {
		this.python = options.python ?? "python";
		this.kernelTimeoutMs = options.kernelTimeoutMs ?? 120_000;
		this.execImpl = options.exec ?? defaultExec;
	}

	/** Probe the local GPU once via nvidia-smi, cache the result. */
	async available(): Promise<boolean> {
		if (this.probed) return this.gpuName !== null;
		this.probed = true;
		const result = await this.execImpl("nvidia-smi --query-gpu=name --format=csv,noheader", 15_000);
		const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
		this.gpuName = line && line.length > 0 ? line : null;
		return this.gpuName !== null;
	}

	/** Name of the local GPU (e.g. "NVIDIA GeForce RTX 2050"). */
	async name(): Promise<string> {
		if (!this.probed) await this.available();
		return this.gpuName ?? "unknown";
	}

	/**
	 * Run a GPU kernel described as Python source. The snippet runs under
	 * torch with cuda:0, so matrix/inference work lands on GPU silicon.
	 * Source is written to a temp .py file and executed (avoids shell
	 * quoting issues with inline python -c on Windows).
	 */
	async runKernel(pythonSource: string, timeoutMs?: number): Promise<string> {
		const code = [
			"import torch",
			"assert torch.cuda.is_available(), 'no cuda device'",
			"print('GPU:', torch.cuda.get_device_name(0))",
			pythonSource,
		].join("\n");
		const script = await this.writeTempScript(code);
		const command = `${this.python} ${script}`;
		const result = await this.execImpl(command, timeoutMs ?? this.kernelTimeoutMs);
		// Clean up after use, not before (python needs to read the file).
		void rm(script, { force: true }).catch(() => undefined);
		if (result.code !== 0) {
			throw new Error(`gpu kernel failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		}
		return result.stdout.trim();
	}

	/** Write a temp python script, return its path (cleaned up by runKernel). */
	private async writeTempScript(code: string): Promise<string> {
		const file = join(tmpdir(), `pi-gpu-kernel-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
		await writeFile(file, code, "utf8");
		return file;
	}
}
