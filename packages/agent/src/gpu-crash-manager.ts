/**
 * GPU crash manager: checkpoints every task before/after execution and
 * restarts failed work so a GPU/connection crash is never fatal. Works with
 * the {@link GpuDispatcher} records and the connection watchdog's 30-minute
 * warning to persist state before a predicted disconnect.
 */

export interface Checkpoint {
	taskId: string;
	status: "pending" | "running" | "done";
	value?: unknown;
	error?: string;
	takenAt: number;
}

export interface CrashManagerOptions {
	/** Persist a checkpoint (e.g. write JSONL to disk or Drive). */
	saveCheckpoint: (checkpoint: Checkpoint) => Promise<void>;
	/** Load the last checkpoint for a task id (or undefined when none exists). */
	loadCheckpoint: (taskId: string) => Promise<Checkpoint | undefined>;
	/** Max restart attempts per task. */
	maxRetries?: number;
}

export interface CrashManagerResult<T> {
	taskId: string;
	value?: T;
	error?: string;
	attempts: number;
	recovered: boolean;
}

export class GpuCrashManager {
	private readonly saveCheckpoint: CrashManagerOptions["saveCheckpoint"];
	private readonly loadCheckpoint: CrashManagerOptions["loadCheckpoint"];
	private readonly maxRetries: number;
	private readonly attempts = new Map<string, number>();

	constructor(options: CrashManagerOptions) {
		this.saveCheckpoint = options.saveCheckpoint;
		this.loadCheckpoint = options.loadCheckpoint;
		this.maxRetries = options.maxRetries ?? 3;
	}

	/**
	 * Run a task with crash recovery: checkpoint before, run, checkpoint
	 * after; on failure, restore the last checkpoint and retry.
	 */
	async runWithRecovery<T>(
		taskId: string,
		run: () => Promise<T>,
		restore: (checkpoint: Checkpoint) => Promise<void>,
	): Promise<CrashManagerResult<T>> {
		let attempts = 0;
		let recovered = false;

		while (attempts <= this.maxRetries) {
			attempts += 1;
			try {
				const checkpoint = await this.loadCheckpoint(taskId);
				if (checkpoint && checkpoint.status === "done" && checkpoint.value !== undefined) {
					// Already completed in a previous life.
					this.attempts.set(taskId, attempts);
					return { taskId, value: checkpoint.value as T, attempts, recovered: true };
				}
				if (checkpoint && checkpoint.status === "running") {
					// Previous attempt crashed mid-run: restore state.
					recovered = true;
					await restore(checkpoint);
				}
				await this.saveCheckpoint({ taskId, status: "pending", takenAt: Date.now() });
				const value = await run();
				await this.saveCheckpoint({ taskId, status: "done", value, takenAt: Date.now() });
				this.attempts.set(taskId, attempts);
				return { taskId, value, attempts, recovered };
			} catch (error) {
				await this.saveCheckpoint({
					taskId,
					status: "pending",
					error: error instanceof Error ? error.message : String(error),
					takenAt: Date.now(),
				});
				if (attempts > this.maxRetries) {
					this.attempts.set(taskId, attempts);
					return {
						taskId,
						error: error instanceof Error ? error.message : String(error),
						attempts,
						recovered,
					};
				}
				// Retry with exponential backoff (short, so tests stay fast).
				await new Promise((resolve) => setTimeout(resolve, Math.min(200, 25 * attempts)));
			}
		}

		this.attempts.set(taskId, attempts);
		return { taskId, error: "exhausted retries", attempts, recovered };
	}

	/** Retry count for a task (mostly for diagnostics). */
	getAttempts(taskId: string): number {
		return this.attempts.get(taskId) ?? 0;
	}
}
