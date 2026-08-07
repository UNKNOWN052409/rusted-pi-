import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const liveAuditSchema = Type.Object({
	path: Type.String({ description: "Path to the file to watch or audit live" }),
	checkIntervalMs: Type.Optional(Type.Integer({ description: "Poll interval in milliseconds" })),
});

export type LiveAuditToolInput = Static<typeof liveAuditSchema>;

export interface LiveAuditCheck {
	checkedAt: number;
	exists: boolean;
	size: number;
	mtimeMs: number;
}

export interface LiveAuditReport {
	path: string;
	checks: LiveAuditCheck[];
	changed: boolean;
}

/**
 * A live-audit tool: polls a file for changes (size / mtime) a bounded number
 * of times, which is the connection-watchdog's "is this resource still alive?"
 * primitive. The single-pass bounded form keeps the harness tool deterministic
 * (no infinite timers), while still exercising the polling path.
 */
export function createLiveAuditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	maxChecks = 5,
): AgentHarnessTool<TContext, typeof liveAuditSchema, LiveAuditReport> {
	return {
		name: "live_audit",
		label: "Live Audit",
		description:
			"Poll a file for changes (existence, size, mtime). Runs at most a bounded number of checks so it never hangs the agent loop.",
		parameters: liveAuditSchema,
		async execute(_toolCallId, { path, checkIntervalMs }, signal, _onUpdate, { env }) {
			const absolutePath = await resolveToolPath(env, path);
			const interval = Math.max(1, Math.min(checkIntervalMs ?? 10, 500));
			const checks: LiveAuditCheck[] = [];
			const first = getOrThrow(await env.fileInfo(absolutePath));
			const baseline = { size: first.size, mtimeMs: first.mtimeMs };
			checks.push({
				checkedAt: Date.now(),
				exists: true,
				size: first.size,
				mtimeMs: first.mtimeMs,
			});
			for (let i = 1; i < maxChecks; i++) {
				if (signal?.aborted) break;
				await new Promise((resolve) => setTimeout(resolve, interval));
				if (signal?.aborted) break;
				const info = getOrThrow(await env.fileInfo(absolutePath));
				checks.push({ checkedAt: Date.now(), exists: true, size: info.size, mtimeMs: info.mtimeMs });
			}
			const changed =
				checks.some((check) => check.size !== baseline.size) ||
				checks.some((check) => check.mtimeMs !== baseline.mtimeMs);
			const report: LiveAuditReport = { path: absolutePath, checks, changed };
			return {
				content: [
					{
						type: "text",
						text: `Live audit of ${path}: ${checks.length} checks, ${changed ? "changed" : "unchanged"} (size ${baseline.size} B).`,
					},
				],
				details: report,
			};
		},
	};
}
