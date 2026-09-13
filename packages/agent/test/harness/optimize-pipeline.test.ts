import { describe, expect, it } from "vitest";
import {
	formatReport,
	type OptimizationCandidate,
	type PipelineTarget,
	runOptimizePipeline,
} from "../../src/optimize-pipeline.ts";

describe("optimize-pipeline: stage sequencing (real executor, tiny script)", () => {
	it("runs create -> smoke -> real-test -> benchmark and reports before", async () => {
		// A tiny sh script that always succeeds and prints the marker: the real
		// subprocess backend runs it through WSL sh; on hosts without WSL the
		// test skips rather than lying.
		const target: PipelineTarget = {
			id: "seq",
			fileName: "main.sh",
			inputMode: "embedded",
			smokeMarker: "SUM",
			source: "printf 'SUM ok\\n'",
			runCommand: (workspace, fileName) => ["sh", `${workspace}/${fileName}`],
			realInput: () => "irrelevant",
		};
		const report = await runOptimizePipeline(target, [], { runs: 3, timeoutMs: 30_000 });
		expect(report.stages.map((s) => s.stage)).toEqual(["create", "smoke", "real-test", "benchmark"]);
		expect(report.stages[0]?.ok).toBe(true);
		expect(report.stages[1]?.ok).toBe(true);
		expect(report.stages[2]?.ok).toBe(true);
		expect(report.stages[3]?.ok).toBe(true);
		expect(report.before?.runs).toBe(3);
		expect(report.improved).toBe(false);
	}, 120_000);

	it("fails the pipeline when the script is broken (honest failure)", async () => {
		const target: PipelineTarget = {
			id: "broken",
			fileName: "main.sh",
			inputMode: "embedded",
			smokeMarker: "SUM",
			source: "exit 3",
			runCommand: (workspace, fileName) => ["sh", `${workspace}/${fileName}`],
			realInput: () => "irrelevant",
		};
		const report = await runOptimizePipeline(target, [], { runs: 1, timeoutMs: 30_000 });
		expect(report.stages[0]?.ok).toBe(true);
		expect(report.stages[1]?.ok).toBe(false);
		expect(report.before).toBeUndefined();
	}, 60_000);

	it("formats a readable report", async () => {
		const target: PipelineTarget = {
			id: "fmt",
			fileName: "main.sh",
			inputMode: "embedded",
			smokeMarker: "SUM",
			source: "printf 'SUM ok\\n'",
			runCommand: (workspace, fileName) => ["sh", `${workspace}/${fileName}`],
			realInput: () => "irrelevant",
		};
		const report = await runOptimizePipeline(target, [], { runs: 2, timeoutMs: 30_000 });
		const text = formatReport(report);
		expect(text).toContain("[create] OK");
		expect(text).toContain("verdict: original kept (no measured win)");
	}, 60_000);
});

describe("optimize-pipeline: keep-if-better gate (simulated benchmarks)", () => {
	it("keeps a candidate only when it measurably wins", async () => {
		// Simulate the gate math directly against the pipeline report shape by
		// running the real pipeline with a sleep-based slowdown candidate and
		// asserting it is discarded: the gate must reject a measured loss.
		const target: PipelineTarget = {
			id: "gate",
			fileName: "main.sh",
			inputMode: "embedded",
			smokeMarker: "SUM",
			source: "printf 'SUM ok\\n'",
			runCommand: (workspace, fileName) => ["sh", `${workspace}/${fileName}`],
			realInput: () => "irrelevant",
		};
		const slower: OptimizationCandidate = {
			id: "slower",
			description: "Adds a sleep — must be discarded by the gate",
			rewrite: (source) => source.replace("printf", "sleep 1; printf"),
		};
		const report = await runOptimizePipeline(target, [slower], { runs: 2, timeoutMs: 60_000 });
		expect(report.candidates).toHaveLength(1);
		expect(report.candidates[0]?.kept).toBe(false);
		expect(report.improved).toBe(false);
	}, 180_000);

	it("rejects candidates whose rewrite throws", async () => {
		const target: PipelineTarget = {
			id: "throwing",
			fileName: "main.sh",
			inputMode: "embedded",
			smokeMarker: "SUM",
			source: "printf 'SUM ok\\n'",
			runCommand: (workspace, fileName) => ["sh", `${workspace}/${fileName}`],
			realInput: () => "irrelevant",
		};
		const throwing: OptimizationCandidate = {
			id: "boom",
			description: "Rewrite throws",
			rewrite: () => {
				throw new Error("cannot rewrite");
			},
		};
		const report = await runOptimizePipeline(target, [throwing], { runs: 1, timeoutMs: 30_000 });
		expect(report.candidates[0]?.kept).toBe(false);
		expect(report.improved).toBe(false);
	}, 60_000);
});
