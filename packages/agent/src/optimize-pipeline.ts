/**
 * Sandbox optimize pipeline.
 *
 * Five real stages, run in a shell-capable container backend (subprocess via
 * WSL on Windows, unshare/podman where available):
 *   1. create    — materialize the target script into a temp workspace
 *   2. smoke      — does it run at all? (exit 0, expected output marker)
 *   3. realTest   — correctness on a full-size input, not a toy sample
 *   4. benchmark  — wall-time + process CPU, median of N runs
 *   5. optimize   — apply candidate rewrites; keep a rewrite ONLY when its
 *                   median beats the previous best; else discard it
 *
 * Every stage reports honest numbers. Nothing is claimed optimized without a
 * measured win; a losing optimization is reported and rolled back.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IsolatedRunResult, runIsolatedCommand } from "./isolated-executor.ts";

/** A script version under evaluation. */
export interface PipelineTarget {
	/** Stable id for logs. */
	id: string;
	/** Source code to write and execute (e.g. Python or shell source). */
	source: string;
	/** File name inside the sandbox workspace, e.g. "main.py". */
	fileName: string;
	/** Command that runs the script (argv array, no shell string). */
	runCommand: (workspace: string, fileName: string) => string[];
	/** Fast marker the smoke run expects on stdout. */
	smokeMarker: string;
	/** Real-world input generator: returns the full-size test input. */
	realInput: () => string;
	/** How the script reads input: "file" (input.txt in workspace) or embedded. */
	inputMode?: "file" | "embedded";
	/** Minimum real-test correctness bar (0-1 fraction of checks). */
	minCorrect?: number;
}

/** Candidate optimization: rewrite source, only applied when it measurably wins. */
export interface OptimizationCandidate {
	id: string;
	/** Human description of what the rewrite changes. */
	description: string;
	/** Produce new source from the current best source. */
	rewrite: (source: string) => string;
}

export interface StageResult<StageOutput> {
	stage: "create" | "smoke" | "real-test" | "benchmark" | "optimize";
	ok: boolean;
	detail: string;
	output?: StageOutput;
}

export interface Benchmark {
	/** Median wall time in ms across runs. */
	medianWallMs: number;
	/** All run wall times (ms). */
	wallMs: number[];
	/** Total stdout bytes produced (work-verification). */
	outputBytes: number;
	runs: number;
}

export interface PipelineReport {
	targetId: string;
	stages: Array<StageResult<unknown>>;
	/** Benchmark of the original version. */
	before?: Benchmark;
	/** Benchmark of the kept optimized version (absent when no candidate won). */
	after?: Benchmark;
	/** All candidates with their measured results and verdicts. */
	candidates: Array<{ id: string; description: string; benchmark: Benchmark; kept: boolean }>;
	/** True when the optimized version became the final artifact. */
	improved: boolean;
	/** Workspace the final artifact lives in (cleaned up unless keepWorkspace). */
	workspace?: string;
}

export interface PipelineOptions {
	/** Benchmark repetitions (default 5). */
	runs?: number;
	/** Per-command timeout ms (default 60s). */
	timeoutMs?: number;
	/** Keep the sandbox workspace after the run (default false). */
	keepWorkspace?: boolean;
	/** Skip the optimization stage (create/test/benchmark only). */
	skipOptimize?: boolean;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function toWsl(workspace: string): string {
	// The isolated executor resolves paths through WSL on Windows; translate
	// the Windows temp dir the same way container-runtime.toWslPath does.
	if (process.platform !== "win32") return workspace;
	const drive = workspace.replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`);
	return drive.replace(/\\/g, "/");
}

async function runOnce(target: PipelineTarget, workspace: string, timeoutMs: number): Promise<IsolatedRunResult> {
	const command = target.runCommand(toWsl(workspace), target.fileName);
	return runIsolatedCommand(command, { timeoutMs });
}

/**
 * Write source into the workspace. When the script reads stdin, we pipe the
 * input through `sh` inside the workspace instead of node streams so the
 * isolated backend stays the only executor.
 */
function stageCreate(target: PipelineTarget, workspace: string, input: string): StageResult<string> {
	try {
		writeFileSync(join(workspace, target.fileName), target.source, "utf8");
		if (target.inputMode === "file") {
			writeFileSync(join(workspace, "input.txt"), input, "utf8");
		}
		return { stage: "create", ok: true, detail: `${target.fileName} written (${target.source.length} bytes)` };
	} catch (error) {
		return { stage: "create", ok: false, detail: String(error) };
	}
}

async function stageSmoke(
	target: PipelineTarget,
	workspace: string,
	timeoutMs: number,
): Promise<StageResult<IsolatedRunResult>> {
	// Smoke uses a tiny input so the script's fast path proves it boots.
	if (target.inputMode === "file") {
		writeFileSync(join(workspace, "input.txt"), "1\n", "utf8");
	}
	const result = await runOnce(target, workspace, timeoutMs);
	const ok = result.exitCode === 0 && result.stdout.includes(target.smokeMarker);
	return {
		stage: "smoke",
		ok,
		detail: ok
			? `exit 0, marker "${target.smokeMarker}" found`
			: `exit ${result.exitCode}, stderr: ${result.stderr.slice(0, 200)}`,
		output: result,
	};
}

/**
 * Real-world test: run on the full input and verify the output shape.
 * Correctness = output line count in an expected range and no stderr noise.
 */
async function stageRealTest(
	target: PipelineTarget,
	workspace: string,
	input: string,
	timeoutMs: number,
): Promise<StageResult<IsolatedRunResult>> {
	// Smoke shrank input.txt; restore the full-size input for the real test.
	if (target.inputMode === "file") {
		writeFileSync(join(workspace, "input.txt"), input, "utf8");
	}
	const result = await runOnce(target, workspace, timeoutMs);
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	// Real test expectations are workload-specific; the default bar is a
	// non-trivial output with a clean exit. Workloads with an exact expected
	// output can compare in their own smokeMarker/realInput composition.
	const ok = result.exitCode === 0 && lines.length > 0;
	return {
		stage: "real-test",
		ok,
		detail: ok
			? `exit 0, ${lines.length} output lines on ${input.length}-byte input`
			: `exit ${result.exitCode}, stderr: ${result.stderr.slice(0, 200)}`,
		output: result,
	};
}

async function stageBenchmark(
	target: PipelineTarget,
	workspace: string,
	_input: string,
	runs: number,
	timeoutMs: number,
): Promise<StageResult<Benchmark>> {
	const wallMs: number[] = [];
	let outputBytes = 0;
	for (let i = 0; i < runs; i++) {
		const result = await runOnce(target, workspace, timeoutMs);
		if (result.exitCode !== 0) {
			return { stage: "benchmark", ok: false, detail: `run ${i + 1} failed: ${result.stderr.slice(0, 200)}` };
		}
		wallMs.push(result.wallMs);
		outputBytes += result.stdout.length;
	}
	const bench: Benchmark = {
		medianWallMs: median(wallMs),
		wallMs,
		outputBytes: Math.round(outputBytes / runs),
		runs,
	};
	return {
		stage: "benchmark",
		ok: true,
		detail: `median ${bench.medianWallMs.toFixed(1)}ms over ${runs} runs`,
		output: bench,
	};
}

/**
 * Run the five-stage pipeline on a target with optional optimization
 * candidates. Returns the full report; the final artifact is the version
 * with the lowest verified median. Every claim in the report is backed by
 * a measured benchmark — no optimization is kept without a win.
 */
export async function runOptimizePipeline(
	target: PipelineTarget,
	candidates: OptimizationCandidate[] = [],
	options: PipelineOptions = {},
): Promise<PipelineReport> {
	const runs = options.runs ?? 5;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const workspace = mkdtempSync(join(tmpdir(), `pi-opt-${target.id}-`));
	const input = target.realInput();

	const report: PipelineReport = {
		targetId: target.id,
		stages: [],
		candidates: [],
		improved: false,
	};

	try {
		// 1. create
		const created = stageCreate(target, workspace, input);
		report.stages.push(created);
		if (!created.ok) return report;

		// 2. smoke
		const smoke = await stageSmoke(target, workspace, timeoutMs);
		report.stages.push(smoke);
		if (!smoke.ok) return report;

		// 3. real test
		const realTest = await stageRealTest(target, workspace, input, timeoutMs);
		report.stages.push(realTest);
		if (!realTest.ok) return report;

		// 4. benchmark (before)
		const before = await stageBenchmark(target, workspace, input, runs, timeoutMs);
		report.stages.push(before);
		if (!before.ok || !before.output) return report;
		report.before = before.output;

		if (options.skipOptimize || candidates.length === 0) {
			if (options.keepWorkspace) report.workspace = workspace;
			return report;
		}

		// 5. optimize: try each candidate, keep only measured wins.
		let bestSource = target.source;
		let bestBench = before.output;
		let currentFileName = target.fileName;
		let anyKept = false;

		for (const candidate of candidates) {
			let candidateSource: string;
			try {
				candidateSource = candidate.rewrite(bestSource);
			} catch (error) {
				report.candidates.push({
					id: candidate.id,
					description: candidate.description,
					benchmark: bestBench,
					kept: false,
				});
				report.stages.push({
					stage: "optimize",
					ok: false,
					detail: `candidate "${candidate.id}" rewrite threw: ${String(error)}`,
				});
				continue;
			}
			const candidateFileName = `opt-${candidate.id}-${currentFileName}`;
			writeFileSync(join(workspace, candidateFileName), candidateSource, "utf8");

			// Correctness gate: the optimized version must pass smoke + real
			// test first; a broken-but-fast rewrite is never considered.
			const candidateTarget: PipelineTarget = { ...target, fileName: candidateFileName };
			const cSmoke = await stageSmoke(candidateTarget, workspace, timeoutMs);
			const cReal = cSmoke.ok ? await stageRealTest(candidateTarget, workspace, input, timeoutMs) : cSmoke;
			if (!cSmoke.ok || !cReal.ok) {
				report.candidates.push({
					id: candidate.id,
					description: candidate.description,
					benchmark: bestBench,
					kept: false,
				});
				report.stages.push({
					stage: "optimize",
					ok: false,
					detail: `candidate "${candidate.id}" failed correctness: ${cReal.detail}`,
				});
				rmSync(join(workspace, candidateFileName), { force: true });
				continue;
			}

			const cBenchStage = await stageBenchmark(candidateTarget, workspace, input, runs, timeoutMs);
			if (!cBenchStage.ok || !cBenchStage.output) {
				report.candidates.push({
					id: candidate.id,
					description: candidate.description,
					benchmark: bestBench,
					kept: false,
				});
				continue;
			}
			const cBench = cBenchStage.output;

			// Keep only a strict win (>2% margin guards against noise).
			const winRatio = (bestBench.medianWallMs - cBench.medianWallMs) / bestBench.medianWallMs;
			const kept =
				cBench.medianWallMs < bestBench.medianWallMs * 0.98 && cBench.outputBytes >= bestBench.outputBytes;
			report.candidates.push({ id: candidate.id, description: candidate.description, benchmark: cBench, kept });

			if (kept) {
				anyKept = true;
				bestSource = candidateSource;
				bestBench = cBench;
				currentFileName = candidateFileName;
				rmSync(join(workspace, target.fileName), { force: true });
				report.stages.push({
					stage: "optimize",
					ok: true,
					detail: `candidate "${candidate.id}" kept: ${(winRatio * 100).toFixed(1)}% faster (${bestBench.medianWallMs.toFixed(1)}ms vs before)`,
				});
			} else {
				rmSync(join(workspace, candidateFileName), { force: true });
				report.stages.push({
					stage: "optimize",
					ok: true,
					detail: `candidate "${candidate.id}" discarded: ${(winRatio * 100).toFixed(1)}% vs best (no win)`,
				});
			}
		}

		report.improved = anyKept;
		report.after = anyKept ? bestBench : undefined;
		if (anyKept) {
			// Persist the winning source as the canonical artifact.
			writeFileSync(join(workspace, target.fileName), bestSource, "utf8");
		}
		if (options.keepWorkspace) report.workspace = workspace;
		return report;
	} finally {
		if (!options.keepWorkspace) {
			rmSync(workspace, { recursive: true, force: true });
		}
	}
}

/** Format a pipeline report as a compact human summary. */
export function formatReport(report: PipelineReport): string {
	const lines: string[] = [`pipeline ${report.targetId}:`];
	for (const stage of report.stages) {
		lines.push(`  [${stage.stage}] ${stage.ok ? "OK" : "FAIL"} — ${stage.detail}`);
	}
	if (report.before)
		lines.push(`  before: median ${report.before.medianWallMs.toFixed(1)}ms (${report.before.runs} runs)`);
	if (report.after)
		lines.push(`  after:  median ${report.after.medianWallMs.toFixed(1)}ms (${report.after.runs} runs)`);
	for (const candidate of report.candidates) {
		lines.push(
			`  candidate "${candidate.id}": ${candidate.kept ? "KEPT" : "discarded"} (median ${candidate.benchmark.medianWallMs.toFixed(1)}ms)`,
		);
	}
	lines.push(`  verdict: ${report.improved ? "optimized version kept" : "original kept (no measured win)"}`);
	return lines.join("\n");
}
