/**
 * SSH GPU runtime.
 *
 * The bridge that makes "route ALL tasks to the GPU" real. The local
 * low-end device (Raspberry Pi / phone) stays the orchestrator; this runtime
 * forwards task commands over SSH to a GPU box (Google Colab, a rented GPU
 * SSH host, or any box with nvidia-smi). The GPU box does the actual work in
 * parallel; the harness keeps the connection alive, notices when it drops,
 * and warns roughly 30 minutes before the session is predicted to end so the
 * checkpoint/watchdog layers can flush state in time.
 *
 * All SSH execution goes through an injected `exec` so tests run without a
 * real SSH client; the default uses `node:child_process` `exec` with a shell.
 */

import { exec } from "node:child_process";

export interface SshExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a shell command, returns its result. */
export type SshExec = (command: string, timeoutMs?: number) => Promise<SshExecResult>;

export interface SshGpuOptions {
	/** SSH host, e.g. "nyc1.tmate.io". */
	host: string;
	/** SSH user, e.g. the tmate username. */
	user?: string;
	/** SSH port (default 22). */
	port?: number;
	/** Path to a private key for key-based auth. */
	identityFile?: string;
	/** SSH binary to use (default "ssh"). */
	sshBinary?: string;
	/** Connection timeout for probes (default 15s). */
	connectTimeoutMs?: number;
	/** How often to ping the GPU box (default 5s). */
	pingIntervalMs?: number;
	/** Consecutive failed pings before declaring a disconnect (default 3). */
	maxMissedPings?: number;
	/** Predicted session length for ephemeral GPU boxes (default 24h). */
	sessionDurationMs?: number;
	/** Warn this long before the predicted session end (default 30 min). */
	warnBeforeMs?: number;
	/** Injectable executor for tests (defaults to node child_process exec). */
	exec?: SshExec;
}

export interface SshGpuEvents {
	/** Fired once, roughly warnBeforeMs before the predicted session end. */
	onWarning?: (info: { remainingMs: number; sessionStartedAt: number }) => void;
	/** Fired once when the GPU box stops answering pings. */
	onDisconnect?: () => void;
}

/** Parses the GPU name out of an nvidia-smi CSV line. */
function parseGpuName(stdout: string): string | null {
	const line = stdout.trim().split(/\r?\n/)[0]?.trim();
	return line && line.length > 0 ? line : null;
}

export class SshGpuRuntime {
	private readonly host: string;
	private readonly user: string | undefined;
	private readonly port: number;
	private readonly identityFile: string | undefined;
	private readonly sshBinary: string;
	private readonly connectTimeoutMs: number;
	private readonly pingIntervalMs: number;
	private readonly maxMissedPings: number;
	private readonly sessionDurationMs: number;
	private readonly warnBeforeMs: number;
	private readonly execImpl: SshExec;
	private readonly events: SshGpuEvents;

	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private failedPings = 0;
	private connected = false;
	private warned = false;
	private sessionStartedAt: number | null = null;
	private gpuName: string | null = null;
	private probed = false;

	constructor(options: SshGpuOptions, events: SshGpuEvents = {}) {
		this.host = options.host;
		this.user = options.user;
		this.port = options.port ?? 22;
		this.identityFile = options.identityFile;
		this.sshBinary = options.sshBinary ?? "ssh";
		this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
		this.pingIntervalMs = options.pingIntervalMs ?? 5_000;
		this.maxMissedPings = options.maxMissedPings ?? 3;
		this.sessionDurationMs = options.sessionDurationMs ?? 24 * 60 * 60 * 1000;
		this.warnBeforeMs = options.warnBeforeMs ?? 30 * 60 * 1000;
		this.execImpl = options.exec ?? defaultSshExec;
		this.events = events;
	}

	/** Base ssh invocation with common flags. */
	private baseCommand(): string {
		const parts = [this.sshBinary];
		parts.push("-o", "BatchMode=yes");
		parts.push("-o", `ConnectTimeout=${Math.ceil(this.connectTimeoutMs / 1000)}`);
		parts.push("-o", "StrictHostKeyChecking=no");
		parts.push("-o", "ServerAliveInterval=15");
		parts.push("-o", "ServerAliveCountMax=3");
		if (this.port !== 22) parts.push("-p", String(this.port));
		if (this.identityFile) parts.push("-i", this.identityFile);
		const target = this.user ? `${this.user}@${this.host}` : this.host;
		parts.push(target);
		return parts.join(" ");
	}

	/**
	 * Probe the GPU box once. Resolves true when nvidia-smi reports a GPU.
	 * The result is cached until a disconnect resets it.
	 */
	async available(): Promise<boolean> {
		if (this.probed && this.connected) return this.gpuName !== null;
		const result = await this.execImpl(
			`${this.baseCommand()} "nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1"`,
			this.connectTimeoutMs,
		);
		this.probed = true;
		this.gpuName = parseGpuName(result.stdout);
		return this.gpuName !== null;
	}

	/** Name of the GPU (e.g. "Tesla T4"), or "unknown" when not probed. */
	async name(): Promise<string> {
		if (!this.probed) await this.available();
		return this.gpuName ?? "unknown";
	}

	/** Run a command on the GPU box and return trimmed stdout. */
	async runRemote(command: string, timeoutMs?: number): Promise<string> {
		const result = await this.execImpl(
			`${this.baseCommand()} "${command.replace(/"/g, '\\"')}"`,
			timeoutMs ?? this.connectTimeoutMs,
		);
		if (result.code !== 0) {
			throw new Error(`remote command failed (${result.code}): ${result.stderr.trim() || command}`);
		}
		return result.stdout.trim();
	}

	/** Begin the keepalive ping loop. Idempotent. */
	start(): void {
		if (this.pingTimer) return;
		this.pingTimer = setInterval(() => {
			void this.ping().catch(() => {
				// ping failures are recorded inside ping()
			});
		}, this.pingIntervalMs);
		this.pingTimer.unref?.();
	}

	/** Stop the keepalive ping loop. */
	stop(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	/** True while the GPU box is answering pings. */
	isConnected(): boolean {
		return this.connected;
	}

	private async ping(): Promise<void> {
		const result = await this.execImpl(`${this.baseCommand()} "echo ok"`, Math.max(2_000, this.pingIntervalMs));
		if (result.code === 0) {
			if (!this.connected) {
				// (Re)connected: record session start the first time.
				if (this.sessionStartedAt === null) this.sessionStartedAt = Date.now();
				this.connected = true;
			}
			this.failedPings = 0;
			this.maybeWarn();
			return;
		}
		this.failedPings += 1;
		if (this.connected && this.failedPings >= this.maxMissedPings) {
			this.connected = false;
			this.events.onDisconnect?.();
		}
	}

	private maybeWarn(): void {
		if (this.warned || this.sessionStartedAt === null) return;
		const elapsed = Date.now() - this.sessionStartedAt;
		const remainingMs = this.sessionDurationMs - elapsed;
		if (remainingMs <= this.warnBeforeMs) {
			this.warned = true;
			this.events.onWarning?.({ remainingMs: Math.max(0, remainingMs), sessionStartedAt: this.sessionStartedAt });
		}
	}
}

/** Default executor: node child_process exec with a shell. */
async function defaultSshExec(command: string, timeoutMs?: number): Promise<SshExecResult> {
	return new Promise<SshExecResult>((resolve) => {
		exec(command, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		});
	});
}
