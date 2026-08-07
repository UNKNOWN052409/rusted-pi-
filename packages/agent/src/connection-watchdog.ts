/**
 * Connection watchdog: keeps a remote connection (tmate / GPU SSH / Colab)
 * alive by checking it on a heartbeat, warns ~30 minutes before a predicted
 * disconnect, and emits checkpoint signals so work can be persisted.
 *
 * The 30-minute rule exists because ephemeral shells (tmate, Colab, cloud
 * VMs) routinely die with no warning — the tmate box we probed went down
 * mid-measurement with only "Internal error" / HTTP 503. The watchdog makes
 * the drop survivable: it notices, warns, and checkpoints.
 */

export interface WatchdogOptions {
	/** How often to check the connection (ms). */
	heartbeatMs?: number;
	/** How far in advance to warn about a predicted disconnect (ms). */
	warnBeforeMs?: number;
	/** How many missed heartbeats before declaring the connection lost. */
	missedHeartbeatLimit?: number;
	/** Called on every successful heartbeat. */
	onHeartbeat?: (info: { sinceStartMs: number; sessionAgeMs: number }) => void;
	/** Called when the connection is close to a predicted disconnect. */
	onWarning?: (info: { minutesRemaining: number; reason: string }) => void;
	/** Called when the connection is considered lost. */
	onDisconnect?: (info: { lastSeenMs: number }) => void;
	/** Called when a checkpoint should be taken. */
	onCheckpoint?: (info: { atMs: number }) => void;
}

export interface WatchdogState {
	connected: boolean;
	lastSeenMs: number;
	missedHeartbeats: number;
	warningIssued: boolean;
	disconnectAnnounced: boolean;
	checkpointAtMs: number | null;
}

export class ConnectionWatchdog {
	private readonly heartbeatMs: number;
	private readonly warnBeforeMs: number;
	private readonly missedHeartbeatLimit: number;
	private readonly onHeartbeat?: WatchdogOptions["onHeartbeat"];
	private readonly onWarning?: WatchdogOptions["onWarning"];
	private readonly onDisconnect?: WatchdogOptions["onDisconnect"];
	private readonly onCheckpoint?: WatchdogOptions["onCheckpoint"];
	private readonly sessionStartedAt = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly state: WatchdogState;

	/** ~30 minutes (the standard Colab/tmate idle disconnect window). */
	static readonly DEFAULT_WARN_BEFORE_MS = 30 * 60 * 1000;
	/** ~25 minutes: checkpoint cadence inside the warning window. */
	static readonly CHECKPOINT_INTERVAL_MS = 25 * 60 * 1000;

	constructor(options: WatchdogOptions = {}) {
		this.heartbeatMs = options.heartbeatMs ?? 5_000;
		this.warnBeforeMs = options.warnBeforeMs ?? ConnectionWatchdog.DEFAULT_WARN_BEFORE_MS;
		this.missedHeartbeatLimit = options.missedHeartbeatLimit ?? 3;
		this.onHeartbeat = options.onHeartbeat;
		this.onWarning = options.onWarning;
		this.onDisconnect = options.onDisconnect;
		this.onCheckpoint = options.onCheckpoint;
		this.state = {
			connected: false,
			lastSeenMs: 0,
			missedHeartbeats: 0,
			warningIssued: false,
			disconnectAnnounced: false,
			checkpointAtMs: null,
		};
	}

	/**
	 * Start the watchdog. `check` must resolve to true when the remote is
	 * reachable (e.g. a shell ping or an HTTP health probe).
	 */
	start(check: () => Promise<boolean>): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick(check);
		}, this.heartbeatMs);
	}

	async tick(check: () => Promise<boolean>): Promise<void> {
		const now = Date.now();
		const alive = await safeCheck(check);
		if (alive) {
			this.state.connected = true;
			this.state.lastSeenMs = now;
			this.state.missedHeartbeats = 0;
			this.onHeartbeat?.({
				sinceStartMs: now - this.sessionStartedAt,
				sessionAgeMs: now - this.sessionStartedAt,
			});

			// Predict a disconnect (ephemeral shell sessions end after a fixed
			// window). Warn once ~30 minutes before, then checkpoint.
			const minutesRemaining = this.minutesUntilPredictedEnd(now);
			if (!this.state.warningIssued && minutesRemaining <= 30) {
				this.state.warningIssued = true;
				this.onWarning?.({ minutesRemaining: Math.max(0, minutesRemaining), reason: "predicted session end" });
			}
			if (!this.state.checkpointAtMs && minutesRemaining <= 30) {
				this.state.checkpointAtMs = now;
				this.onCheckpoint?.({ atMs: now });
			}
			return;
		}

		this.state.missedHeartbeats += 1;
		if (this.state.missedHeartbeats >= this.missedHeartbeatLimit) {
			this.state.connected = false;
			if (!this.state.disconnectAnnounced) {
				this.state.disconnectAnnounced = true;
				this.onDisconnect?.({ lastSeenMs: this.state.lastSeenMs });
			}
		}
	}

	/** Session runs on a ~24h ephemeral window for tmate/Colab-style shells. */
	private minutesUntilPredictedEnd(now: number): number {
		const sessionWindowMs = 24 * 60 * 60 * 1000;
		const elapsed = now - this.sessionStartedAt;
		return Math.max(0, (sessionWindowMs - elapsed) / 60_000);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getState(): WatchdogState {
		return { ...this.state };
	}
}

async function safeCheck(check: () => Promise<boolean>): Promise<boolean> {
	try {
		return (await check()) === true;
	} catch {
		return false;
	}
}
