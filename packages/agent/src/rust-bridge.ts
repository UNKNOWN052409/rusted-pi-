/**
 * Rust-core bridge.
 *
 * Wires the pi-native Rust binary (packages/rust-core) into the agent
 * package. The binary speaks a line-oriented JSON protocol over
 * stdin/stdout: one command per line, one JSON response per line.
 *
 * This bridge is queue-based: concurrent calls never interleave responses
 * (each command is written to the subprocess only after the previous one
 * answered). All exports degrade gracefully when the binary is missing
 * (e.g. browser builds, fresh checkouts): detect* helpers return "not
 * available" shapes, never throw.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** GPU report from the pi-native `detect-gpu` command. */
export interface RustGpuInfo {
	available: boolean;
	name: string;
	vramMb: number;
	computeCapability: number;
	smCount: number;
	isWddm: boolean;
}

/** CPU load sample from the pi-native `cpu-load` command. */
export interface RustCpuLoad {
	load: number;
	coreCount: number;
	shouldYield: boolean;
}

/** Stability verdict from the pi-native `stability-check` command. */
export interface RustStabilityResult {
	pass: boolean;
	issues: Array<{ type: string; severity: string; detail: string; pattern?: string }>;
	suggestedAction: string;
	source: string;
}

/** API format guess from the pi-native `detect-api` command. */
export interface RustApiDetection {
	api: string;
	confidence: number;
	providerName: string;
	isKnownProvider: boolean;
}

/** Compaction decision from the pi-native `compaction-should-compact` command. */
export interface RustCompactionVerdict {
	shouldCompact: boolean;
	/** Human-readable reason from the Rust side. */
	reason: string;
}

export interface RustBridgeOptions {
	/**
	 * Injectable command runner for tests: receives a full stdin script
	 * (commands joined by newlines, including a trailing "exit") and returns
	 * the raw stdout string. When omitted, the real pi-native subprocess is
	 * spawned and reused across calls.
	 */
	runScript?: (script: string) => Promise<string>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Resolve the pi-native binary path relative to this package layout. */
export function piNativeBinaryPath(): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	// agent/src -> ../../rust-core (repo layout) or packaged dist -> ../rust-core
	const candidates = [
		join(moduleDir, "..", "..", "rust-core", "target", "release", `pi-native${ext}`),
		join(moduleDir, "..", "rust-core", "target", "release", `pi-native${ext}`),
	];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}
	return null;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	command: string;
	timer: ReturnType<typeof setTimeout>;
}

/** Shared subprocess state for the default (non-injected) runner. */
const subprocessState = {
	proc: null as ChildProcess | null,
	stdout: null as ReadlineInterface | null,
	startupError: null as Error | null,
	queue: [] as PendingCall[],
	inFlight: false,
};

function startSubprocess(): ChildProcess | null {
	if (subprocessState.proc) return subprocessState.proc;
	if (subprocessState.startupError) return null;

	const binary = piNativeBinaryPath();
	if (!binary) {
		subprocessState.startupError = new Error(
			"pi-native binary not found (build: cd packages/rust-core && cargo build --release)",
		);
		return null;
	}

	const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const stdout = createInterface({ input: proc.stdout, crlfDelay: Infinity });

	stdout.on("line", (line) => {
		const call = subprocessState.queue[0];
		if (!call) return;
		clearTimeout(call.timer);
		subprocessState.queue.shift();
		try {
			call.resolve(JSON.parse(line));
		} catch (error) {
			call.reject(error instanceof Error ? error : new Error(String(error)));
		}
	});

	proc.on("error", (error) => {
		subprocessState.startupError = error;
		void teardown();
	});

	proc.on("exit", (code) => {
		void teardown();
		// Fail everything still queued; a fresh call will restart the process.
		const pending = subprocessState.queue.splice(0);
		for (const call of pending) {
			clearTimeout(call.timer);
			call.reject(new Error(`pi-native exited with code ${code}`));
		}
	});

	subprocessState.proc = proc;
	subprocessState.stdout = stdout;
	return proc;
}

async function teardown(): Promise<void> {
	const proc = subprocessState.proc;
	subprocessState.proc = null;
	subprocessState.stdout = null;
	if (proc) {
		proc.stdout?.destroy();
		proc.kill();
	}
}

async function runViaSubprocess(command: string): Promise<unknown> {
	const proc = startSubprocess();
	if (!proc || !subprocessState.stdout) {
		throw subprocessState.startupError ?? new Error("pi-native failed to start");
	}

	return new Promise<unknown>((resolve, reject) => {
		const call: PendingCall = {
			resolve,
			reject,
			command,
			timer: setTimeout(() => {
				const index = subprocessState.queue.indexOf(call);
				if (index >= 0) subprocessState.queue.splice(index, 1);
				reject(new Error(`pi-native command timed out: ${command.split(" ")[0]}`));
			}, 15_000),
		};
		subprocessState.queue.push(call);
		proc.stdin?.write(`${command}\n`);
	});
}

/**
 * Bridge instance: holds the injectable runner, falls back to the shared
 * persistent subprocess. Create one and reuse it; the default bridge talks
 * to the same long-lived pi-native process across all commands.
 */
export class RustBridge {
	private readonly runScript: ((script: string) => Promise<string>) | null;

	constructor(options: RustBridgeOptions = {}) {
		this.runScript = options.runScript ?? null;
	}

	private async send(command: string): Promise<unknown> {
		if (this.runScript) {
			const stdout = await this.runScript(`${command}\nexit\n`);
			const line = stdout.trim().split(/\r?\n/)[0];
			if (!line) throw new Error("pi-native returned no output");
			return JSON.parse(line);
		}
		return runViaSubprocess(command);
	}

	/** Detect the local GPU via the Rust binary. Graceful fallback when absent. */
	async detectGpu(): Promise<RustGpuInfo> {
		try {
			return (await this.send("detect-gpu")) as RustGpuInfo;
		} catch {
			return { available: false, name: "", vramMb: 0, computeCapability: 0, smCount: 0, isWddm: false };
		}
	}

	/** Sample CPU load (0-1) and the Rust-side yield recommendation. */
	async cpuLoad(threshold?: number): Promise<RustCpuLoad> {
		try {
			const load = (await this.send("cpu-load")) as RustCpuLoad;
			if (threshold !== undefined) load.shouldYield = load.load > threshold;
			return load;
		} catch {
			return { load: 0, coreCount: 0, shouldYield: false };
		}
	}

	/** Total system memory in MB. */
	async systemMemoryMb(): Promise<number> {
		try {
			return ((await this.send("system-memory")) as { totalMb: number }).totalMb;
		} catch {
			return 0;
		}
	}

	/** Stability check (fabricated-model / repetition / hallucination patterns). */
	async stabilityCheck(text: string, modelId?: string): Promise<RustStabilityResult> {
		try {
			return (await this.send(
				`stability-check ${JSON.stringify({ text, modelId: modelId ?? "" })}`,
			)) as RustStabilityResult;
		} catch {
			return { pass: true, issues: [], suggestedAction: "allow", source: "rust-bridge-unavailable" };
		}
	}

	/** Guess the API format for a base URL. */
	async detectApi(url: string): Promise<RustApiDetection> {
		try {
			return (await this.send(`detect-api ${JSON.stringify({ url })}`)) as RustApiDetection;
		} catch {
			return { api: "openai-completions", confidence: 0, providerName: "Custom Provider", isKnownProvider: false };
		}
	}

	/** DuckDuckGo web search via the Rust binary. */
	async searchWeb(
		query: string,
	): Promise<{ success: boolean; results: Array<{ title: string; url: string }>; resultCount: number }> {
		try {
			return (await this.send(`search-web ${JSON.stringify({ query })}`)) as {
				success: boolean;
				query: string;
				results: Array<{ title: string; url: string }>;
				resultCount: number;
			};
		} catch {
			return { success: false, results: [], resultCount: 0 };
		}
	}

	/** Fetch a URL's text (50 KB truncated) via the Rust binary. */
	async fetchUrl(
		url: string,
	): Promise<{ success: boolean; text?: string; status?: number; error?: string; length?: number }> {
		try {
			return (await this.send(`fetch-url ${JSON.stringify({ url })}`)) as {
				success: boolean;
				text?: string;
				status?: number;
				error?: string;
				length?: number;
			};
		} catch {
			return { success: false, error: "pi-native unavailable" };
		}
	}

	/** Ask the Rust binary whether context compaction should trigger. */
	async shouldCompact(
		contextTokens: number,
		contextWindow: number,
		reserveTokens?: number,
	): Promise<RustCompactionVerdict> {
		try {
			return (await this.send(
				`compaction-should-compact ${JSON.stringify({ contextTokens, contextWindow, reserveTokens })}`,
			)) as RustCompactionVerdict;
		} catch {
			return { shouldCompact: false, reason: "pi-native unavailable" };
		}
	}

	/** Stop the underlying subprocess (safe to call repeatedly). */
	shutdown(): void {
		if (this.runScript) return;
		const pending = subprocessState.queue.splice(0);
		for (const call of pending) {
			clearTimeout(call.timer);
			call.reject(new Error("pi-native bridge shut down"));
		}
		void teardown();
	}
}

process.once("exit", () => {
	void teardown();
});
