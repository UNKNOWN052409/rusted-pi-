/**
 * future-agi premium features, ported to Erasable TS with zero runtime deps.
 *
 * 1. GuardrailEngine — the agentcc-gateway guardrails engine: pre/post rules,
 *    sync/async execution modes, fail-open semantics, and a hard cap on the
 *    number of concurrent async guardrails (the Go original caps at 64).
 * 2. A2A task protocol — the Agent-to-Agent (A2A) contract: agent cards,
 *    task lifecycle (working/completed/failed/canceled/input_required),
 *    messages and artifacts, so one rusted-pi instance can delegate to another.
 * 3. Sliding-window alert rule — threshold + window + cooldown alerting, the
 *    same shape as agentcc-gateway's alerting manager, for progress/monitor
 *    integration.
 *
 * All three map 1:1 onto the future-agi Go types; only the platform-specific
 * HTTP/Docker wrappers are dropped.
 */

// ---------------------------------------------------------------------------
// 1. Guardrail engine
// ---------------------------------------------------------------------------

export type GuardrailMode = "sync" | "async";
export type GuardrailAction = "block" | "warn" | "allow";

export interface GuardrailRule {
	name: string;
	mode: GuardrailMode;
	action: GuardrailAction;
	threshold?: number;
	timeoutMs?: number;
}

export interface GuardrailContext {
	/** Free-form input the guardrail inspects (prompt, output, code, etc.). */
	input: unknown;
}

export interface GuardrailResult {
	name: string;
	action: GuardrailAction;
	blocked: boolean;
	reason: string;
	value?: number;
}

/** A guardrail implementation: pure function over the context. */
export type Guardrail = (name: string, ctx: GuardrailContext) => Promise<GuardrailResult>;

export interface GuardrailEngineOptions {
	rules: GuardrailRule[];
	registry: Map<string, Guardrail>;
	failOpen?: boolean;
	defaultTimeoutMs?: number;
	maxAsync?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ASYNC = 64;

/**
 * Mirrors agentcc-gateway's guardrails.Engine: resolves rules against a
 * registry, skips unknown names with a warning-equivalent result, bounds async
 * concurrency with a semaphore, and fails open on timeouts when configured.
 */
export class GuardrailEngine {
	private readonly rules: GuardrailRule[];
	private readonly registry: Map<string, Guardrail>;
	private readonly failOpen: boolean;
	private readonly defaultTimeoutMs: number;
	private readonly maxAsync: number;
	private activeAsync = 0;

	constructor(options: GuardrailEngineOptions) {
		this.rules = options.rules;
		this.registry = options.registry;
		this.failOpen = options.failOpen ?? false;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxAsync = options.maxAsync ?? DEFAULT_MAX_ASYNC;
	}

	/** Runs every guardrail rule in order; returns the first blocking result. */
	async run(ctx: GuardrailContext): Promise<GuardrailResult[]> {
		const results: GuardrailResult[] = [];
		for (const rule of this.rules) {
			const impl = this.registry.get(rule.name);
			if (!impl) {
				results.push({
					name: rule.name,
					action: this.failOpen ? "allow" : "block",
					blocked: !this.failOpen,
					reason: `guardrail not found in registry (failOpen=${this.failOpen})`,
				});
				continue;
			}
			let result: GuardrailResult;
			if (rule.mode === "async") {
				result = await this.runAsync(impl, rule, ctx);
			} else {
				result = await this.runSync(impl, rule, ctx);
			}
			results.push(result);
			if (result.blocked) break; // short-circuit like a block action
		}
		return results;
	}

	private async runSync(impl: Guardrail, rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailResult> {
		return this.withTimeout(impl(rule.name, ctx), rule);
	}

	private async runAsync(impl: Guardrail, rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailResult> {
		// Bounded concurrency: never exceed maxAsync in-flight async guardrails.
		while (this.activeAsync >= this.maxAsync) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		this.activeAsync++;
		try {
			return await this.withTimeout(impl(rule.name, ctx), rule);
		} finally {
			this.activeAsync--;
		}
	}

	private async withTimeout(promise: Promise<GuardrailResult>, rule: GuardrailRule): Promise<GuardrailResult> {
		const timeoutMs = rule.timeoutMs ?? this.defaultTimeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<GuardrailResult>((resolve) => {
					timer = setTimeout(() => {
						resolve({
							name: rule.name,
							action: this.failOpen ? "allow" : "block",
							blocked: !this.failOpen,
							reason: `guardrail timed out after ${timeoutMs}ms (failOpen=${this.failOpen})`,
						});
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

// ---------------------------------------------------------------------------
// 2. A2A task protocol
// ---------------------------------------------------------------------------

export type A2ATaskState = "working" | "completed" | "failed" | "canceled" | "input_required";

export interface A2AArtifact {
	name?: string;
	description?: string;
	parts: A2AMessagePart[];
}

export interface A2AMessagePart {
	kind: "text" | "file";
	text?: string;
	uri?: string;
	mimeType?: string;
}

export interface A2AMessage {
	role: "user" | "agent";
	parts: A2AMessagePart[];
	metadata?: Record<string, string>;
}

export interface A2ATask {
	id: string;
	contextId?: string;
	state: A2ATaskState;
	artifacts: A2AArtifact[];
	history: A2AMessage[];
	metadata?: Record<string, string>;
}

export interface A2AAgentCard {
	name: string;
	description?: string;
	url: string;
	version: string;
	capabilities: { streaming: boolean; pushNotifications: boolean };
	skills: A2ASkill[];
}

export interface A2ASkill {
	id: string;
	name: string;
	description?: string;
	tags: string[];
}

export interface A2ATaskEvent {
	type: "task/status-update" | "task/artifact-update";
	task: A2ATask;
}

const A2A_VALID_STATES: A2ATaskState[] = ["working", "completed", "failed", "canceled", "input_required"];

/**
 * A2A task ledger — the wire contract from agentcc-gateway's a2a package.
 * Tracks task lifecycle transitions with validation so one rusted-pi instance
 * can hand work to another over a tunnel and both agree on state.
 */
export class A2ATaskLedger {
	private readonly tasks = new Map<string, A2ATask>();

	createTask(id: string, contextId?: string, metadata?: Record<string, string>): A2ATask {
		const task: A2ATask = {
			id,
			contextId,
			state: "working",
			artifacts: [],
			history: [],
			metadata,
		};
		this.tasks.set(id, task);
		return task;
	}

	getTask(id: string): A2ATask | undefined {
		return this.tasks.get(id);
	}

	updateState(id: string, state: A2ATaskState, message?: string): A2ATask {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`task not found: ${id}`);
		}
		if (!A2A_VALID_STATES.includes(state)) {
			throw new Error(`invalid task state: ${state}`);
		}
		if (task.state === "completed" || task.state === "failed" || task.state === "canceled") {
			throw new Error(`task ${id} already in terminal state ${task.state}`);
		}
		task.state = state;
		if (message !== undefined) {
			task.history.push({ role: "agent", parts: [{ kind: "text", text: message }] });
		}
		return task;
	}

	addArtifact(id: string, artifact: A2AArtifact): A2ATask {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`task not found: ${id}`);
		}
		task.artifacts.push(artifact);
		return task;
	}

	appendMessage(id: string, role: "user" | "agent", parts: A2AMessagePart[]): A2ATask {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`task not found: ${id}`);
		}
		task.history.push({ role, parts });
		return task;
	}

	listTasks(): A2ATask[] {
		return [...this.tasks.values()];
	}

	events(task: A2ATask): A2ATaskEvent[] {
		const events: A2ATaskEvent[] = [];
		if (task.artifacts.length > 0) {
			events.push({ type: "task/artifact-update", task });
		}
		events.push({ type: "task/status-update", task });
		return events;
	}
}

// ---------------------------------------------------------------------------
// 3. Sliding-window alert rule
// ---------------------------------------------------------------------------

export type AlertCondition = "gte" | "lte";

export interface AlertRule {
	name: string;
	metric: string;
	condition: AlertCondition;
	threshold: number;
	windowMs: number;
	cooldownMs: number;
	channels: string[];
}

export interface AlertEvent {
	name: string;
	metric: string;
	value: number;
	threshold: number;
	windowMs: number;
	firedAt: number;
	channels: string[];
}

interface AlertState {
	values: WindowEntry[];
	lastFired: number;
}

/**
 * Sliding-window alert rule with cooldown, mirroring agentcc-gateway's
 * alerting.Rule (WindowCounter + cooldown). A rule fires only once per
 * cooldown window; values older than windowMs drop out of the sliding window.
 */
export class AlertRuleEngine {
	private readonly rule: AlertRule;
	private readonly state: AlertState;
	private readonly now: () => number;

	constructor(rule: AlertRule, now: () => number = Date.now) {
		this.rule = rule;
		// Never-fired sentinel: the Go original uses the zero time value (year 1),
		// which makes `t - lastFired` huge, so the first observation always fires
		// past the cooldown check. -Infinity reproduces that exactly.
		this.state = { values: [], lastFired: Number.NEGATIVE_INFINITY };
		this.now = now;
	}

	observe(value: number): AlertEvent | undefined {
		const t = this.now();
		// Drop values outside the sliding window.
		this.state.values = this.state.values.filter((entry) => entry.ts > t - this.rule.windowMs);
		this.state.values.push({ ts: t, value });

		const inWindow = this.state.values;
		if (inWindow.length === 0) return undefined;
		const avg = inWindow.reduce((sum, entry) => sum + entry.value, 0) / inWindow.length;
		const fired = this.rule.condition === "gte" ? avg >= this.rule.threshold : avg <= this.rule.threshold;
		if (!fired) return undefined;

		if (t - this.state.lastFired < this.rule.cooldownMs) return undefined;
		this.state.lastFired = t;
		return {
			name: this.rule.name,
			metric: this.rule.metric,
			value: avg,
			threshold: this.rule.threshold,
			windowMs: this.rule.windowMs,
			firedAt: t,
			channels: this.rule.channels,
		};
	}

	reset(): void {
		this.state.values = [];
		this.state.lastFired = 0;
	}
}

interface WindowEntry {
	ts: number;
	value: number;
}
