/**
 * GPU offload dispatcher.
 *
 * When a GPU is attached (Google Colab, a GPU SSH box, or a local CUDA
 * device), ALL tasks — even CPU-only ones — are routed to the GPU and run
 * concurrently, so everything is fast and reliable. When no GPU is present,
 * tasks fall back to a plain in-process executor. The dispatcher tracks
 * active tasks as records so the connection watchdog / crash manager can
 * checkpoint them.
 */

export interface GpuTask<TResult = unknown> {
	id: string;
	/** Executes the task (on the GPU when present, otherwise in-process). */
	run: () => Promise<TResult>;
	/** Human label for logging/checkpointing. */
	label?: string;
}

export interface GpuRuntime {
	/** Resolve true when a GPU is actually available (nvidia-smi, etc.). */
	available: () => Promise<boolean>;
	/** Name of the GPU, e.g. "T4" or "A100". */
	name?: () => Promise<string>;
}

/** Task lifecycle status, as a const object (erasable-syntax friendly). */
export const GpuTaskStatus = {
	Queued: "queued",
	Running: "running",
	Succeeded: "succeeded",
	Failed: "failed",
} as const;

export type GpuTaskStatus = (typeof GpuTaskStatus)[keyof typeof GpuTaskStatus];

export interface GpuTaskRecord {
	id: string;
	status: GpuTaskStatus;
	startedAt: number;
	finishedAt: number | null;
	error?: string;
	label?: string;
}

/** Result of a task execution, keyed by task id, recorded for checkpointing. */
export interface GpuRunResult<T> {
	id: string;
	value?: T;
	error?: string;
	status: GpuTaskStatus;
}

export class GpuDispatcher {
	private readonly runtime: GpuRuntime | null;
	private readonly active: number;
	private readonly offloadAll: boolean;
	private readonly records = new Map<string, GpuTaskRecord>();
	private gpu = false;
	private checked = false;

	constructor(options: {
		/** GPU runtime to offload to, or null when this device has no GPU. */
		runtime?: GpuRuntime | null;
		/** Max concurrent tasks (GPU parallelism). */
		concurrency?: number;
		/** Route even CPU tasks to the GPU? Defaults to true (route everything). */
		offloadAll?: boolean;
	}) {
		this.runtime = options.runtime ?? null;
		this.active = Math.max(1, options.concurrency ?? 1);
		this.offloadAll = options.offloadAll ?? true;
	}

	/** True when a GPU is connected and taking the work (and offloading is enabled). */
	get mode(): "gpu" | "cpu" {
		return this.gpu && this.offloadAll ? "gpu" : "cpu";
	}

	/** Probe the GPU once (lazily) and cache availability. */
	async detect(): Promise<"gpu" | "cpu"> {
		if (this.checked) return this.mode;
		this.checked = true;
		this.gpu = this.runtime ? await this.runtime.available() : false;
		return this.mode;
	}

	private recordFor(task: GpuTask<unknown>): GpuTaskRecord {
		return {
			id: task.id,
			status: GpuTaskStatus.Queued,
			startedAt: 0,
			finishedAt: null,
			label: task.label,
		};
	}

	/**
	 * Run a batch of tasks. When a GPU is present all tasks are routed to it
	 * and run with bounded concurrency. Returns results in input order; a
	 * failed task yields `{ status: GpuTaskStatus.Failed, error }`.
	 */
	async runAll<T>(tasks: GpuTask<T>[]): Promise<GpuRunResult<T>[]> {
		await this.detect();
		for (const task of tasks) {
			this.records.set(task.id, this.recordFor(task));
		}

		const results = new Array<GpuRunResult<T> | null>(tasks.length).fill(null);
		let cursor = 0;

		const execute = async (task: GpuTask<T>, index: number): Promise<void> => {
			const record = this.records.get(task.id);
			if (record) {
				record.status = GpuTaskStatus.Running;
				record.startedAt = Date.now();
			}
			try {
				const value = await task.run();
				results[index] = { id: task.id, value, status: GpuTaskStatus.Succeeded };
				if (record) {
					record.status = GpuTaskStatus.Succeeded;
					record.finishedAt = Date.now();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results[index] = { id: task.id, error: message, status: GpuTaskStatus.Failed };
				if (record) {
					record.status = GpuTaskStatus.Failed;
					record.error = message;
					record.finishedAt = Date.now();
				}
			}
		};

		const pump = async (): Promise<void> => {
			while (cursor < tasks.length) {
				const index = cursor;
				const task = tasks[index]!;
				cursor += 1;
				await execute(task, index);
			}
		};

		const workers = Array.from({ length: Math.min(this.active, Math.max(1, tasks.length)) }, () => pump());
		await Promise.all(workers);

		return results.map((result) => result ?? { id: "", status: GpuTaskStatus.Failed, error: "no result" });
	}

	/** Snapshot of task records (for checkpointing). */
	snapshot(): GpuTaskRecord[] {
		return Array.from(this.records.values()).map((record) => ({ ...record }));
	}

	/** How many tasks are still queued or running. */
	get outstanding(): number {
		return Array.from(this.records.values()).filter(
			(record) => record.status === GpuTaskStatus.Queued || record.status === GpuTaskStatus.Running,
		).length;
	}
}
