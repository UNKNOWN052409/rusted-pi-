/**
 * Effort levels — the agent can be run at low / minimum / high / xhigh.
 *
 * Each level maps to concrete knobs (max tokens per step, tool-call
 * concurrency, timeout, and whether the swarm/10-terminal mode is enabled).
 * Levels are validated and clamped so callers never receive an invalid value.
 */

export type EffortLevel = "low" | "minimum" | "high" | "xhigh";

export interface EffortProfile {
	level: EffortLevel;
	/** Max tokens the model may spend per single step. */
	maxTokensPerStep: number;
	/** Number of parallel tool calls allowed. */
	toolConcurrency: number;
	/** Per-step timeout in ms. */
	timeoutMs: number;
	/** Whether swarm / multi-terminal coordination is enabled. */
	swarm: boolean;
	/** Whether subagent spawn is enabled. */
	subagents: boolean;
	/** 0-1 budget multiplier for compaction aggressiveness. */
	compactionThresholdScale: number;
}

const PROFILES: Record<EffortLevel, EffortProfile> = {
	low: {
		level: "low",
		maxTokensPerStep: 1_024,
		toolConcurrency: 1,
		timeoutMs: 30_000,
		swarm: false,
		subagents: false,
		compactionThresholdScale: 0.5,
	},
	minimum: {
		level: "minimum",
		maxTokensPerStep: 2_048,
		toolConcurrency: 2,
		timeoutMs: 60_000,
		swarm: false,
		subagents: true,
		compactionThresholdScale: 0.7,
	},
	high: {
		level: "high",
		maxTokensPerStep: 8_192,
		toolConcurrency: 4,
		timeoutMs: 120_000,
		swarm: true,
		subagents: true,
		compactionThresholdScale: 1.0,
	},
	xhigh: {
		level: "xhigh",
		maxTokensPerStep: 16_384,
		toolConcurrency: 10,
		timeoutMs: 300_000,
		swarm: true,
		subagents: true,
		compactionThresholdScale: 1.3,
	},
};

const VALID_LEVELS: EffortLevel[] = ["low", "minimum", "high", "xhigh"];

/** Validate a raw string as an effort level; throws on unknown values. */
export function parseEffortLevel(value: string): EffortLevel {
	if (!VALID_LEVELS.includes(value as EffortLevel)) {
		throw new Error(`Unknown effort level "${value}" (expected low|minimum|high|xhigh)`);
	}
	return value as EffortLevel;
}

/** Get the profile for a level. */
export function effortProfile(level: EffortLevel): EffortProfile {
	return PROFILES[level];
}
