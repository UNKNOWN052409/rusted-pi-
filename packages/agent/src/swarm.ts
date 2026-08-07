/**
 * Swarm coordinator — runs one core with many terminal/worker slots, assigns
 * tasks so no worker is idle-redundant and no task is duplicated (no mess, no
 * AI slop).
 *
 * A shared in-memory task queue is drained by a bounded pool of workers. Each
 * task is processed exactly once. When a GPU is present (detected via a
 * GpuRuntime), tasks still run through the swarm (the GPU makes them fast); on
 * a CPU-only box the swarm degrades to a plain worker pool. Coordination
 * events let an orchestrator know which terminal took which task.
 */

import type { EffortLevel } from "./effort-levels.ts";

export interface SwarmTask<TResult = unknown> {
	id: string;
	/** Actual work to perform. */
	run: () => Promise<TResult>;
	/** Human label for coordination/logging. */
	label?: string;
}

export type WorkerStatus = "idle" | "busy";

export interface WorkerState {
	id: number;
	status: WorkerStatus;
	currentTaskId: string | null;
	startedAt: number | null;
}

export type CoordinationEvent =
	| { kind: "assigned"; workerId: number; taskId: string; label?: string; timestamp: number }
	| { kind: "succeeded"; workerId: number; taskId: string; label?: string; timestamp: number }
	| { kind: "failed"; workerId: number; taskId: string; label?: string; error?: string; timestamp: number }
	| { kind: "drained"; workerId: number; taskId: null; timestamp: number };

export interface SwarmOptions {
	/** Number of terminal/worker slots (default 10). */
	workers?: number;
	/** Effort level — scales worker count when not explicitly given. */
	effort?: EffortLevel;
	/** Emitted on every coordination event (orchestration hook). */
	onEvent?: (event: CoordinationEvent) => void;
	/** GPU availability probe; resolves true when a GPU can take the work. */
	gpuAvailable?: () => Promise<boolean>;
}

export interface SwarmRunResult<T> {
	/** Results keyed by task id. */
	results: Map<string, { value?: T; error?: string; ok: boolean }>;
	/** How many workers were active (single-core terminal slots). */
	workerCount: number;
	/** Whether a GPU was detected as the compute backend. */
	gpu: boolean;
	/** Coordination events emitted during the run. */
	events: CoordinationEvent[];
}

/** Effort level scales the effective worker pool (xhigh = full 10 terminals). */
export function workerCountForEffort(effort: EffortLevel, requested?: number): number {
	if (requested !== undefined) return Math.max(1, requested);
	switch (effort) {
		case "low":
			return 1;
		case "minimum":
			return 2;
		case "high":
			return 6;
		case "xhigh":
			return 10;
	}
}

export class SwarmCoordinator {
	private readonly workerCount: number;
	private readonly effort: EffortLevel;
	private readonly onEvent: ((event: CoordinationEvent) => void) | undefined;
	private readonly gpuAvailable: (() => Promise<boolean>) | null;
	/** Live worker states, updated as tasks are assigned/completed. */
	private readonly workers: WorkerState[];

	constructor(options: SwarmOptions = {}) {
		this.effort = options.effort ?? "high";
		this.workerCount = workerCountForEffort(this.effort, options.workers);
		this.onEvent = options.onEvent;
		this.gpuAvailable = options.gpuAvailable ?? null;
		this.workers = Array.from({ length: this.workerCount }, (_, id) => ({
			id,
			status: "idle",
			currentTaskId: null,
			startedAt: null,
		}));
	}

	/** Current worker pool state (for progress/tracking). */
	workerStates(): WorkerState[] {
		return this.workers.map((w) => ({ ...w }));
	}

	/** Number of terminals currently busy. */
	get busyCount(): number {
		return this.workers.filter((w) => w.status === "busy").length;
	}

	/**
	 * Run all tasks through the swarm with at most the configured worker
	 * terminals. Every task is drained exactly once (no duplication). Returns a
	 * map of results together with the coordination trail.
	 */
	async runSwarm<T>(tasks: SwarmTask<T>[], options: SwarmOptions = {}): Promise<SwarmRunResult<T>> {
		const workerCount = Math.max(1, options.workers ?? this.workerCount);
		const gpu = this.gpuAvailable
			? await this.gpuAvailable().catch(() => false)
			: this.effort === "xhigh" || this.effort === "high";
		const results = new Map<string, { value?: T; error?: string; ok: boolean }>();
		const events: CoordinationEvent[] = [];
		let cursor = 0;
		const emit = (event: CoordinationEvent): void => {
			events.push(event);
			this.onEvent?.(event);
		};
		const worker = this.workers[0] ?? { id: 0, status: "idle" as WorkerStatus, currentTaskId: null, startedAt: null };

		const workerRun = async (workerId: number): Promise<void> => {
			for (;;) {
				const index = cursor;
				if (index >= tasks.length) break;
				cursor += 1;
				const task = tasks[index]!;
				if (workerId >= this.workers.length) {
					// Pooled workers beyond the initial array (options.workers > default):
					// run without live-state tracking.
					emit({ kind: "assigned", workerId, taskId: task.id, label: task.label, timestamp: Date.now() });
					try {
						const value = await task.run();
						results.set(task.id, { value, ok: true });
						emit({ kind: "succeeded", workerId, taskId: task.id, label: task.label, timestamp: Date.now() });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						results.set(task.id, { error: message, ok: false });
						emit({
							kind: "failed",
							workerId,
							taskId: task.id,
							label: task.label,
							error: message,
							timestamp: Date.now(),
						});
					}
					continue;
				}
				this.workers[workerId]!.status = "busy";
				this.workers[workerId]!.currentTaskId = task.id;
				this.workers[workerId]!.startedAt = Date.now();
				emit({ kind: "assigned", workerId, taskId: task.id, label: task.label, timestamp: Date.now() });
				try {
					const value = await task.run();
					results.set(task.id, { value, ok: true });
					emit({ kind: "succeeded", workerId, taskId: task.id, label: task.label, timestamp: Date.now() });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					results.set(task.id, { error: message, ok: false });
					emit({
						kind: "failed",
						workerId,
						taskId: task.id,
						label: task.label,
						error: message,
						timestamp: Date.now(),
					});
				} finally {
					this.workers[workerId]!.status = "idle";
					this.workers[workerId]!.currentTaskId = null;
					this.workers[workerId]!.startedAt = null;
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(workerCount, Math.max(1, tasks.length)) }, (_, i) => workerRun(i)),
		);
		emit({ kind: "drained", workerId: worker.id, taskId: null, timestamp: Date.now() });

		return { results, workerCount, gpu, events };
	}
}
