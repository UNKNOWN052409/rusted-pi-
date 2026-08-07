import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { auditFile, type CodeAuditReport } from "./code-audit.ts";
import { computeMoeBudget, detectDeviceProfile, MIN_WAKE_SLOTS } from "./moe-tools.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const multiAuditSchema = Type.Object({
	paths: Type.Array(Type.String({ description: "Absolute or cwd-relative paths of files/directories to audit" })),
	recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories when a path is a directory" })),
	concurrency: Type.Optional(
		Type.Integer({ description: "Cap fan-out concurrency; defaults to the MoE wake budget" }),
	),
});

export type MultiAuditToolInput = Static<typeof multiAuditSchema>;

export interface MultiAuditPathResult {
	path: string;
	fileCount: number;
	lineCount: number;
	issues: number;
	errors: number;
	ok: boolean;
}

export interface MultiAuditReport {
	paths: MultiAuditPathResult[];
	fileCount: number;
	lineCount: number;
	issues: number;
	errors: number;
	ok: boolean;
	wakeParallelism: number;
	concurrency: number;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|py|go)$/;

/**
 * jcode-style multi-terminal audit. Fans out `auditFile` (the code-audit
 * engine) across several paths/terminals in parallel, gated by the MoE wake
 * budget so a 1-core device never oversubscribes: fan-out is capped at
 * `computeMoeBudget(profile).wakeParallelism` (floor 1) unless the caller
 * passes a lower `concurrency`. Aggregates into one report.
 *
 * A per-file audit is orchestrated here (instead of importing the unbounded
 * `createCodeAuditTool` directory walk) so N paths run concurrently but the
 * number of simultaneous audits is bounded.
 */
async function auditPath(
	env: ExecutionToolContext["env"],
	absolutePath: string,
	recursive: boolean,
): Promise<CodeAuditReport> {
	const info = getOrThrow(await env.fileInfo(absolutePath));
	if (info.kind === "file") {
		return auditFile(env, absolutePath);
	}

	const reports: CodeAuditReport[] = [];
	const walk = async (dir: string): Promise<void> => {
		const children = getOrThrow(await env.listDir(dir));
		for (const child of children) {
			const childPath = child.path;
			if (child.kind === "file" && CODE_EXT.test(child.name)) {
				reports.push(await auditFile(env, childPath));
			} else if (child.kind === "directory" && recursive) {
				await walk(childPath);
			}
		}
	};
	await walk(absolutePath);

	const lineCount = reports.reduce((sum, report) => sum + report.lineCount, 0);
	const issues = reports.flatMap((report) => report.issues);
	const report: CodeAuditReport = {
		path: absolutePath,
		fileCount: reports.length,
		lineCount,
		issues,
		ok: issues.every((issue) => issue.severity !== "error"),
	};
	return report;
}

async function runBounded<T>(
	items: string[],
	concurrency: number,
	worker: (item: string, index: number) => Promise<T>,
): Promise<T[]> {
	const out: T[] = new Array(items.length);
	let cursor = 0;
	async function pump(): Promise<void> {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			out[index] = await worker(items[index], index);
		}
	}
	const limit = Math.max(MIN_WAKE_SLOTS, concurrency);
	const runners = Array.from({ length: Math.min(limit, items.length) }, () => pump());
	await Promise.all(runners);
	return out;
}

export function createMultiAuditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof multiAuditSchema,
	MultiAuditReport
> {
	return {
		name: "multi_audit",
		label: "Multi-Terminal Audit",
		description:
			"Audit several files/directories in parallel (jcode multi-terminal style), fan-out bounded by the MoE wake budget to avoid oversubscribing 1-core devices. Reports TODOs, FIXMEs, unchecked any, debugger, console logging, and empty catch blocks.",
		parameters: multiAuditSchema,
		async execute(_toolCallId, { paths, recursive, concurrency }, _signal, _onUpdate, { env }) {
			const absolutePaths = paths.map((p) => resolveToolPath(env, p));
			const resolved = await Promise.all(absolutePaths);
			const profile = detectDeviceProfile();
			const budget = computeMoeBudget(profile);
			const cap = Math.min(concurrency ?? budget.wakeParallelism, budget.wakeParallelism);
			const reports = await runBounded(resolved, cap, (p) => auditPath(env, p, recursive ?? false));

			const perPath: MultiAuditPathResult[] = reports.map((report) => ({
				path: report.path,
				fileCount: report.fileCount,
				lineCount: report.lineCount,
				issues: report.issues.length,
				errors: report.issues.filter((i) => i.severity === "error").length,
				ok: report.ok,
			}));
			const fileCount = reports.reduce((sum, r) => sum + r.fileCount, 0);
			const lineCount = reports.reduce((sum, r) => sum + r.lineCount, 0);
			const issues = reports.reduce((sum, r) => sum + r.issues.length, 0);
			const errors = perPath.reduce((sum, r) => sum + r.errors, 0);
			const report: MultiAuditReport = {
				paths: perPath,
				fileCount,
				lineCount,
				issues,
				errors,
				ok: errors === 0,
				wakeParallelism: budget.wakeParallelism,
				concurrency: cap,
			};
			return {
				content: [
					{
						type: "text",
						text: `Multi audit: ${perPath.length} path(s), ${fileCount} files (${lineCount} lines): ${issues} issue(s), ${errors} error(s) across ${cap} concurrent workers (MoE wake budget ${budget.wakeParallelism}).`,
					},
				],
				details: report,
			};
		},
	};
}
