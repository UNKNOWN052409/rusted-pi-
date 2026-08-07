/**
 * Tool router — the agent always knows which tool to use when.
 *
 * Matches a task description against a registry of tool capabilities using a
 * deterministic keyword table (optionally extended by an LLM hook) and returns
 * ranked tool suggestions. The registry is injected so tests can script it and
 * real callers can pass the harness tool set.
 */

import type { EffortLevel } from "./effort-levels.ts";

export interface ToolCapability {
	name: string;
	description: string;
	/** Keywords that suggest this tool. */
	keywords: string[];
	/** Lower is more specialized; the router ranks by best (highest) score. */
	weight: number;
}

export interface ToolRouteOptions {
	effort?: EffortLevel;
	/** Optional LLM/hook to refine ranking; receives the top candidates. */
	refine?: (task: string, candidates: Array<{ name: string; score: number }>) => Promise<string[]>;
}

export interface RouteResult {
	/** Ranked tool names, best first. */
	tools: string[];
	/** Scores per tool name (higher = better match). */
	scores: Record<string, number>;
	/** Best single tool. */
	best: string;
}

/** Score a task against one capability (case-insensitive keyword overlap). */
export function scoreTask(task: string, capability: ToolCapability): number {
	const lowered = task.toLowerCase();
	let hits = 0;
	for (const kw of capability.keywords) {
		if (lowered.includes(kw.toLowerCase())) hits++;
	}
	return hits * capability.weight;
}

/**
 * Rank all capabilities for a task. Capabilities with zero keyword hits are
 * omitted unless `includeZero` is set.
 */
export function rankTools(task: string, capabilities: ToolCapability[], includeZero = false): RouteResult {
	const scored = capabilities
		.map((cap) => ({ name: cap.name, score: scoreTask(task, cap) }))
		.filter((c) => includeZero || c.score > 0)
		.sort((a, b) => b.score - a.score);
	const scores: Record<string, number> = {};
	for (const c of scored) scores[c.name] = c.score;
	return {
		tools: scored.map((c) => c.name),
		scores,
		best: scored.length > 0 ? scored[0].name : "",
	};
}

/**
 * Route a task to the best tool, optionally letting an LLM refine the ranking.
 * Returns an empty best when nothing matched.
 */
export async function routeTask(
	task: string,
	capabilities: ToolCapability[],
	options: ToolRouteOptions = {},
): Promise<RouteResult> {
	const result = rankTools(task, capabilities);
	if (options.refine && result.tools.length > 0) {
		const refined = await options.refine(
			task,
			result.tools.map((name) => ({ name, score: result.scores[name] })),
		);
		if (refined.length > 0) {
			const reordered = [...refined, ...result.tools.filter((t) => !refined.includes(t))];
			const scores: Record<string, number> = {};
			reordered.forEach((name, i) => {
				scores[name] = result.scores[name] ?? result.tools.length - i;
			});
			return { tools: reordered, scores, best: reordered[0] };
		}
	}
	return result;
}

/** Default capability registry covering the harness builtin tools. */
export function defaultCapabilities(): ToolCapability[] {
	return [
		{
			name: "bash",
			description: "Run shell commands, install, build, test, git",
			keywords: ["run", "install", "build", "test", "git", "command", "shell", "execute", "npm", "terminal"],
			weight: 1,
		},
		{
			name: "read",
			description: "Read files and directories",
			keywords: ["read", "file", "view", "cat", "show", "inspect", "source"],
			weight: 1,
		},
		{
			name: "write",
			description: "Write or overwrite files",
			keywords: ["write", "create", "save", "new file", "overwrite"],
			weight: 1,
		},
		{
			name: "edit",
			description: "Edit existing files precisely",
			keywords: ["edit", "change", "modify", "update", "fix", "replace", "patch"],
			weight: 1,
		},
		{
			name: "grep",
			description: "Search inside files",
			keywords: ["search", "grep", "find", "locate", "where is", "look for"],
			weight: 1,
		},
		{
			name: "web_search",
			description: "Search the web for latest data",
			keywords: ["latest", "news", "web search", "search the web", "current", "2024", "2025", "recent"],
			weight: 1,
		},
	];
}
