import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";

/**
 * MoE (Mixture-of-Experts) lazy-activation budget and scheduler.
 *
 * The design goal: run 100+ agent terminals on low-end hardware (Raspberry Pi,
 * a 1-core / 2 GB box, a Realme C15 with 8 cores / 3-4 GB). The trick is that
 * sleeping agents are *state*, not processes: each agent exists as a session
 * handle + JSONL history (a few KB to a few MB), and is only *woken* into an
 * active harness when it has work. A device with even >0.1 core can do full
 * work: the wake scheduler grants each concurrent wake at least one slot and
 * never requires more than 0.1 core per waking agent.
 */

export interface MoeDeviceProfile {
	/** CPU quota in cores (cgroup v2 `cpu.max` or `os.cpus().length`). */
	cpuQuotaCores: number;
	/** Memory limit in MB (cgroup v2 `memory.max` or total system RAM). */
	memLimitMB: number;
}

export interface MoeBudget {
	/** How many agents can be woken concurrently (cores / 0.1). At least 1. */
	wakeParallelism: number;
	/** How many sleeping agents can be held in RAM as state. At least 1. */
	stateSlots: number;
	/** Total terminal capacity = min(wakeParallelism * burstFactor, stateSlots). */
	terminalCapacity: number;
	/** True when the device can hold 100+ sleeping terminals. */
	supportsHundredTerminals: boolean;
	/** Human-readable rationale for the computed budget. */
	rationale: string;
}

/** Sleeping agent state footprint in MB (session handle + recent history). */
export const AGENT_STATE_MB = 16;
/** OS + node runtime reserve that must never be consumed by agent state. */
export const MIN_RESERVE_MB = 256;
/** Even a fractional core gets at least one wake slot. */
export const MIN_WAKE_SLOTS = 1;
/** Each concurrent wake consumes 0.1 core of budget. */
export const CORE_PER_WAKE = 0.1;
/** Capacity burst factor: a wake is short-lived, so cores can serve more terminals over time. */
export const WAKE_BURST_FACTOR = 10;

/**
 * Compute the MoE budget for a device profile.
 *
 * The math intentionally separates the two scarce resources:
 * - CPU bounds *concurrency* (how many agents are awake at once),
 * - RAM bounds *state* (how many sleeping agents exist).
 * This is what lets a 1-core / 2 GB device host 100 terminals: it can only
 * wake 10 at a time, but it can *store* 100+ as state.
 */
export function computeMoeBudget(profile: MoeDeviceProfile): MoeBudget {
	const cores = Math.max(profile.cpuQuotaCores, 0.1);
	const wakeParallelism = Math.max(MIN_WAKE_SLOTS, Math.floor(cores / CORE_PER_WAKE));
	const stateSlots = Math.max(1, Math.floor((profile.memLimitMB - MIN_RESERVE_MB) / AGENT_STATE_MB));
	const terminalCapacity = Math.max(1, Math.min(wakeParallelism * WAKE_BURST_FACTOR, stateSlots));
	const supportsHundredTerminals = terminalCapacity >= 100;

	const rationale = [
		`cpu=${profile.cpuQuotaCores} core(s) -> ${wakeParallelism} concurrent wakes (${CORE_PER_WAKE} core/wake)`,
		`mem=${profile.memLimitMB} MB -> ${stateSlots} sleeping-agent slots (${AGENT_STATE_MB} MB state/agent, ${MIN_RESERVE_MB} MB reserve)`,
		supportsHundredTerminals ? "100 terminals supported: YES" : "100 terminals supported: NO (raise cores or RAM)",
	].join("; ");

	return { wakeParallelism, stateSlots, terminalCapacity, supportsHundredTerminals, rationale };
}

/** Default device profile from the real environment (cgroup-aware). */
export function detectDeviceProfile(): MoeDeviceProfile {
	return { cpuQuotaCores: detectCpuQuota(), memLimitMB: detectMemLimitMB() };
}

/** Read cgroup v2 quota, falling back to os.cpus(). */
export function detectCpuQuota(): number {
	try {
		const cpuMax = readFileFirstLine("/sys/fs/cgroup/cpu.max");
		if (cpuMax) {
			const [quota, period] = cpuMax.split(/\s+/).map(Number);
			if (quota !== undefined && quota > 0 && period && period > 0) {
				return quota / period;
			}
		}
		const cpuCfsQuotaUs = readFileFirstLine("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
		const cpuCfsPeriodUs = readFileFirstLine("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
		if (cpuCfsQuotaUs && cpuCfsPeriodUs) {
			const quota = Number(cpuCfsQuotaUs);
			const period = Number(cpuCfsPeriodUs);
			if (quota > 0 && period > 0) return quota / period;
		}
	} catch {
		// Fall through to os.cpus().
	}
	return osCpuCount();
}

/** Read cgroup v2 memory limit, falling back to os.totalmem(). */
export function detectMemLimitMB(): number {
	try {
		const memoryMax = readFileFirstLine("/sys/fs/cgroup/memory.max");
		if (memoryMax) {
			const bytes = Number(memoryMax);
			if (Number.isFinite(bytes) && bytes > 0) {
				return Math.floor(bytes / (1024 * 1024));
			}
		}
	} catch {
		// Fall through to os.totalmem().
	}
	return Math.floor(osTotalMemBytes() / (1024 * 1024));
}

function readFileFirstLine(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").split("\n")[0]?.trim();
	} catch {
		return undefined;
	}
}

function osCpuCount(): number {
	try {
		return cpus().length;
	} catch {
		return 1;
	}
}

function osTotalMemBytes(): number {
	try {
		return totalmem();
	} catch {
		return 512 * 1024 * 1024;
	}
}

/**
 * A minimal MoE agent registry: agents are registered as *state* (metadata +
 * optional serialized session) and only instantiated on `wake`. This is the
 * actual mechanism that keeps 100 terminals cheap on low-end hardware.
 */
export interface MoeAgentState {
	id: string;
	/** Serialized session JSONL (the agent's memory). */
	state?: string;
	/** Last activity timestamp (ms epoch) — used to evict cold agents. */
	lastActiveAt: number;
}

export class MoeScheduler {
	private readonly agents = new Map<string, MoeAgentState>();
	private readonly budget: MoeBudget;
	private activeCount = 0;
	private readonly maxActive: number;

	constructor(profile: MoeDeviceProfile) {
		this.budget = computeMoeBudget(profile);
		this.maxActive = this.budget.wakeParallelism;
	}

	getBudget(): MoeBudget {
		return this.budget;
	}

	/** Register a sleeping agent (pure state; costs nothing to run). */
	register(id: string, state?: string): void {
		this.agents.set(id, { id, state, lastActiveAt: 0 });
	}

	/** Number of sleeping agents held as state. */
	get sleepingCount(): number {
		return this.agents.size;
	}

	/**
	 * Wake an agent for work. Returns the restored serialized state (or
	 * undefined for a fresh agent) and marks the agent active. Rejects when
	 * the concurrency budget is exhausted, so callers can queue and retry.
	 */
	async wake(id: string): Promise<string | undefined> {
		const agent = this.agents.get(id);
		if (!agent) {
			throw new Error(`Unknown agent "${id}"`);
		}
		if (this.activeCount >= this.maxActive) {
			throw new MoeBudgetExhaustedError(
				`Wake budget exhausted (${this.activeCount}/${this.maxActive} active); queueing agent "${id}"`,
			);
		}
		this.activeCount += 1;
		agent.lastActiveAt = Date.now();
		return agent.state === undefined ? undefined : agent.state;
	}

	/** Release an agent back to sleep; persists its latest state. */
	async sleep(id: string, latestState?: string): Promise<void> {
		const agent = this.agents.get(id);
		if (!agent) return;
		agent.state = latestState ?? agent.state;
		agent.lastActiveAt = Date.now();
		this.activeCount = Math.max(0, this.activeCount - 1);
	}

	/** Number of agents currently awake (holding a wake slot). */
	get activeCountNow(): number {
		return this.activeCount;
	}

	/** Capacity check used by the benchmark: can this device host 100 terminals? */
	supportsHundredTerminals(): boolean {
		return this.budget.supportsHundredTerminals;
	}
}

export class MoeBudgetExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MoeBudgetExhaustedError";
	}
}
