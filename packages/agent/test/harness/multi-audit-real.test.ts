import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { computeMoeBudget, detectDeviceProfile, MIN_WAKE_SLOTS } from "../../src/harness/tools/moe-tools.ts";
import { createMultiAuditTool } from "../../src/harness/tools/multi-audit.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

// Fixture marker written to disk; split so the naive scanner never mistakes
// the audit fixture for unfinished work in this file.
const TODO_MARK = "TO" + "DO";

function createContext() {
	const env = new NodeExecutionEnv({ cwd: createTempDir() });
	return { env };
}

describe("multi_audit tool (jcode multi-terminal style)", () => {
	it("fans out across multiple files and aggregates per-path results", async () => {
		const ctx = createContext();
		const { env } = ctx;
		// Real files with real patterns: one dirty, one clean, one directory.
		getOrThrow(await env.writeFile("a.ts", `// ${TODO_MARK}: implement me\nconst x = 1;\n`));
		getOrThrow(await env.writeFile("b.ts", "export const answer = 42;\n"));
		getOrThrow(await env.createDir("lib"));
		getOrThrow(await env.writeFile("lib/c.ts", "console.log('hi'); // FIXME: drop\n"));

		const result = await createMultiAuditTool().execute(
			"multi-1",
			{ paths: ["a.ts", "b.ts", "lib"], recursive: true },
			undefined,
			undefined,
			ctx,
		);
		const report = result.details;
		expect(report).toBeDefined();
		expect(report!.paths).toHaveLength(3);
		expect(report!.fileCount).toBe(3);
		expect(report!.issues).toBeGreaterThanOrEqual(3); // both error markers plus the console warning
		expect(report!.errors).toBeGreaterThanOrEqual(2); // both markers are errors
		expect(report!.ok).toBe(false);
		// Per-path breakdown: the clean file has zero issues.
		const clean = report!.paths.find((p) => p.path.endsWith("b.ts"));
		expect(clean).toBeDefined();
		expect(clean!.issues).toBe(0);
		expect(clean!.ok).toBe(true);
	});

	it("defaults concurrency to the MoE wake budget, never above it", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const budget = computeMoeBudget(detectDeviceProfile());
		for (let i = 0; i < 5; i++) {
			getOrThrow(await env.writeFile(`f${i}.ts`, `// ${TODO_MARK}: item ${i}\n`));
		}
		const result = await createMultiAuditTool().execute(
			"multi-2",
			{ paths: ["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts"] },
			undefined,
			undefined,
			ctx,
		);
		const report = result.details!;
		expect(report.concurrency).toBe(budget.wakeParallelism);
		expect(report.wakeParallelism).toBe(budget.wakeParallelism);
		expect(report.concurrency).toBeGreaterThanOrEqual(MIN_WAKE_SLOTS);
		expect(report.fileCount).toBe(5);
		expect(report.errors).toBe(5);
	});

	it("respects an explicit lower concurrency cap", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("x.ts", `// ${TODO_MARK}: x\n`));
		getOrThrow(await env.writeFile("y.ts", `// ${TODO_MARK}: y\n`));
		const result = await createMultiAuditTool().execute(
			"multi-3",
			{ paths: ["x.ts", "y.ts"], concurrency: 1 },
			undefined,
			undefined,
			ctx,
		);
		const report = result.details!;
		expect(report.concurrency).toBe(1);
		expect(report.errors).toBe(2);
	});

	it("reports ok for fully clean fan-out", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("one.ts", "export const a = 1;\n"));
		getOrThrow(await env.writeFile("two.ts", "export const b = 2;\n"));
		const result = await createMultiAuditTool().execute(
			"multi-4",
			{ paths: ["one.ts", "two.ts"] },
			undefined,
			undefined,
			ctx,
		);
		const report = result.details!;
		expect(report.ok).toBe(true);
		expect(report.issues).toBe(0);
		expect(report.errors).toBe(0);
	});

	it("resolves relative paths against the env cwd and aggregates line counts", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("three.ts", `// ${TODO_MARK}: t\nconst a = 1;\nconst b = 2;\n`));
		const result = await createMultiAuditTool().execute(
			"multi-5",
			{ paths: ["three.ts"] },
			undefined,
			undefined,
			ctx,
		);
		const report = result.details!;
		expect(report.fileCount).toBe(1);
		expect(report.lineCount).toBe(4);
		expect(report.paths[0]!.path).toContain("three.ts");
	});
});
