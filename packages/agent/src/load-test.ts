/**
 * Load testing — determines whether a task's compute lands on the GPU or the
 * CPU.
 *
 * Samples GPU utilization (via nvidia-smi) and CPU utilization (via os.cpus())
 * while a task runs, then classifies the dominant resource. GPU/CPU reader
 * functions are injectable so tests can run scripted readers without assuming
 * a GPU is present.
 */

import { execFile } from "node:child_process";
import { cpus } from "node:os";

export interface LoadSample {
	timestamp: number;
	/** 0-100 GPU utilization, -1 when no GPU is present/reachable. */
	gpuUtil: number;
	/** 0-100 aggregate CPU utilization. */
	cpuUtil: number;
}

export interface LoadResult {
	/** Which resource carried the load. */
	dominant: "gpu" | "cpu" | "balanced";
	/** Samples taken during the task. */
	samples: LoadSample[];
	/** Peak GPU utilization observed (0 when no GPU). */
	peakGpuUtil: number;
	/** Peak CPU utilization observed. */
	peakCpuUtil: number;
	/** Whether an NVIDIA GPU was detected at all. */
	gpuPresent: boolean;
}

export interface LoadTestOptions {
	/** Interval between samples, ms (default 100). */
	sampleIntervalMs?: number;
	/** GPU utilization reader; defaults to a real nvidia-smi probe. */
	readGpuUtil?: () => Promise<number>;
	/** CPU utilization reader; defaults to os.cpus() delta sampling. */
	readCpuUtil?: () => Promise<number>;
	/** Force GPU presence reporting (tests). */
	forceGpu?: boolean;
}

/**
 * Read GPU utilization via nvidia-smi; -1 when no GPU is reachable.
 * Uses `--query-gpu=utilization.gpu` (a plain number 0-100).
 */
export async function readGpuUtil(): Promise<number> {
	try {
		const out = await new Promise<string>((resolve, reject) => {
			execFile(
				"nvidia-smi",
				["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
				{ timeout: 5_000, windowsHide: true },
				(err, stdout) => {
					if (err) reject(err);
					else resolve(String(stdout));
				},
			);
		});
		const value = Number(out.trim().split("\n")[0]);
		return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : -1;
	} catch {
		return -1;
	}
}

export interface CpuTimes {
	user: number;
	nice: number;
	sys: number;
	idle: number;
	irq: number;
	iowait?: number;
	steal?: number;
}

/** Total CPU idle/total across all cores. */
export function cpuTotals(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const c of cpus()) {
		const t = c.times as CpuTimes;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq + (t.iowait ?? 0) + (t.steal ?? 0);
	}
	return { idle, total };
}

/** Read aggregate CPU utilization (0-100) via two back-to-back snapshots. */
export async function readCpuUtil(): Promise<number> {
	const a = cpuTotals();
	await new Promise((r) => setTimeout(r, 50));
	const b = cpuTotals();
	const total = b.total - a.total;
	if (total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((1 - (b.idle - a.idle) / total) * 100)));
}

/**
 * Run a task while sampling GPU + CPU utilization, then classify the dominant
 * resource. The executor is injected by the caller (a real compute task or a
 * test stand-in).
 */
export async function runLoadTest(executor: () => Promise<void>, options: LoadTestOptions = {}): Promise<LoadResult> {
	const sampleIntervalMs = options.sampleIntervalMs ?? 100;
	const readGpu = options.readGpuUtil ?? readGpuUtil;
	const readCpu = options.readCpuUtil ?? readCpuUtil;
	const forceGpu = options.forceGpu;

	const samples: LoadSample[] = [];
	let stopping = false;
	const samplerDone = Promise.resolve();

	const sampler = (async () => {
		while (!stopping) {
			const [gpuUtil, cpuUtil] = await Promise.all([readGpu(), readCpu()]);
			samples.push({ timestamp: Date.now(), gpuUtil, cpuUtil });
			await new Promise((r) => setTimeout(r, sampleIntervalMs));
		}
	})();

	try {
		await executor();
	} finally {
		stopping = true;
		await samplerDone.catch(() => {});
		await sampler;
	}

	if (samples.length === 0) {
		samples.push({ timestamp: Date.now(), gpuUtil: await readGpu(), cpuUtil: await readCpu() });
	}

	const gpuPresent = forceGpu ? true : samples.some((s) => s.gpuUtil >= 0);
	const peakGpuUtil = gpuPresent ? Math.max(...samples.map((s) => s.gpuUtil)) : 0;
	const peakCpuUtil = Math.max(...samples.map((s) => s.cpuUtil));
	const avgGpu = samples.reduce((a, s) => a + s.gpuUtil, 0) / samples.length;
	const avgCpu = samples.reduce((a, s) => a + s.cpuUtil, 0) / samples.length;

	let dominant: LoadResult["dominant"];
	if (!gpuPresent) {
		dominant = "cpu";
	} else if (avgGpu > avgCpu * 1.1) {
		dominant = "gpu";
	} else if (avgCpu > avgGpu * 1.1) {
		dominant = "cpu";
	} else {
		dominant = "balanced";
	}

	return { dominant, samples, peakGpuUtil, peakCpuUtil, gpuPresent };
}
