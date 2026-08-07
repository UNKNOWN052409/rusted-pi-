/**
 * Pi Native — JS bridge for the Rust CLI binary.
 *
 * Spawns pi-native as a persistent subprocess communicating via stdin/stdout JSON.
 * Falls back gracefully if the binary is not found or fails to start.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{ available: boolean, name: string, vramMb: number, computeCapability: number, smCount: number, isWddm: boolean }} GpuInfo
 * @typedef {{ load: number, coreCount: number, shouldYield: boolean }} CpuLoad
 * @typedef {{ totalMb: number }} SystemMemory
 */

/** @type {import("node:child_process").ChildProcess|null} */
let nativeProcess = null;
/** @type {import("node:readline").Interface|null} */
let rl = null;
/** @type {((value: unknown) => void)|null} */
let pendingResolve = null;
/** @type {((reason: Error) => void)|null} */
let pendingReject = null;
/** @type {Error|null} */
let startupError = null;

/**
 * @returns {string}
 */
function getBinaryPath() {
	const ext = process.platform === "win32" ? ".exe" : "";
	const candidates = [
		join(__dirname, "target", "release", "pi-native" + ext),
		join(__dirname, "pi-native" + ext),
		join(__dirname, "..", "target", "release", "pi-native" + ext),
	];

	for (const path of candidates) {
		if (existsSync(path)) return path;
	}

	throw new Error(
		"pi-native binary not found. Build it: cd packages/rust-core && cargo build --release\n" +
			"  Searched: " + candidates.join(", "),
	);
}

function startProcess() {
	if (nativeProcess) return;

	try {
		const binaryPath = getBinaryPath();
		nativeProcess = spawn(binaryPath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		rl = createInterface({ input: nativeProcess.stdout, crlfDelay: Infinity });

		rl.on("line", (line) => {
			if (pendingResolve) {
				const resolve = pendingResolve;
				pendingResolve = null;
				resolve(JSON.parse(line));
			}
		});

		nativeProcess.on("error", (err) => {
			startupError = err;
			nativeProcess = null;
			rl = null;
		});

		nativeProcess.on("exit", (code) => {
			if (pendingReject) {
				const reject = pendingReject;
				pendingReject = null;
				reject(new Error("pi-native exited with code " + code));
			}
			nativeProcess = null;
			rl = null;
		});

		startupError = null;
	} catch (err) {
		startupError = err instanceof Error ? err : new Error(String(err));
		nativeProcess = null;
		rl = null;
	}
}

/**
 * @param {string} command
 * @returns {Promise<unknown>}
 */
async function sendCommand(command) {
	if (startupError) throw startupError;
	if (!nativeProcess || !rl) startProcess();
	if (!nativeProcess || !rl) throw new Error("Failed to start pi-native process");

	return new Promise((resolve, reject) => {
		pendingResolve = resolve;
		pendingReject = reject;

		nativeProcess.stdin.write(command + "\n");

		const timer = setTimeout(() => {
			if (pendingResolve === resolve) {
				pendingResolve = null;
				pendingReject = null;
				reject(new Error('Command "' + command + '" timed out'));
			}
		}, 5000);

		pendingResolve = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
	});
}

/**
 * @returns {Promise<GpuInfo>}
 */
export async function detectGpu() {
	try {
		const result = await sendCommand("detect-gpu");
		return /** @type {GpuInfo} */ (result);
	} catch {
		return { available: false, name: "", vramMb: 0, computeCapability: 0, smCount: 0, isWddm: false };
	}
}

/**
 * @param {number} [threshold]
 * @returns {Promise<CpuLoad>}
 */
export async function cpuLoad(threshold) {
	try {
		const result = await sendCommand("cpu-load");
		const load = /** @type {CpuLoad} */ (result);
		if (threshold !== undefined) {
			load.shouldYield = load.load > threshold;
		}
		return load;
	} catch {
		return { load: 0, coreCount: 4, shouldYield: false };
	}
}

/**
 * @returns {Promise<number>}
 */
export async function systemMemoryMb() {
	try {
		const result = await sendCommand("system-memory");
		return /** @type {SystemMemory} */ (result).totalMb;
	} catch {
		return 4096;
	}
}

/**
 * Run a stability check on text via the Rust binary.
 * @param {string} text
 * @param {{ modelId?: string }}
 * @returns {Promise<{ pass: boolean, issues: Array<{ type: string, severity: string, detail: string }>, suggestedAction: string, source: string }>}
 */
/**
 * Detect API format from URL via Rust binary.
 * @param {string} url
 * @returns {Promise<{ api: string, confidence: number, providerName: string, isKnownProvider: boolean }>}
 */
export async function detectApiFromUrlRust(url) {
	try {
		const result = await sendCommand('detect-api ' + JSON.stringify({ url }));
		return /** @type {*} */ (result);
	} catch {
		return { api: "openai-completions", confidence: 0.3, providerName: "Custom Provider", isKnownProvider: false };
	}
}

/**
 * Search the web via Rust binary (DuckDuckGo).
 * @param {string} query
 * @returns {Promise<{ success: boolean, query: string, results: Array<{ title: string, url: string }>, resultCount: number }>}
 */
export async function searchWebRust(query) {
	try {
		const result = await sendCommand('search-web ' + JSON.stringify({ query }));
		return /** @type {*} */ (result);
	} catch {
		return { success: false, query, results: [], resultCount: 0 };
	}
}

/**
 * Fetch URL content via Rust binary.
 * @param {string} url
 * @returns {Promise<{ success: boolean, text?: string, status?: number, error?: string }>}
 */
export async function fetchUrlRust(url) {
	try {
		const result = await sendCommand('fetch-url ' + JSON.stringify({ url }));
		return /** @type {*} */ (result);
	} catch {
		return { success: false, error: "Rust binary unavailable" };
	}
}

export async function checkStabilityRust(text, opts) {
	try {
		const payload = { text, modelId: opts?.modelId ?? "" };
		const result = await sendCommand("stability-check " + JSON.stringify(payload));
		return /** @type {*} */ (result);
	} catch {
		return {
			pass: true,
			issues: [],
			suggestedAction: "allow",
			source: "rust-fallback-error",
		};
	}
}

export function shutdown() {
	if (nativeProcess) {
		try {
			nativeProcess.stdin.write("exit\n");
		} catch {
			// ignore
		}
		nativeProcess.kill();
		nativeProcess = null;
		rl = null;
	}
}

// Auto-shutdown on process exit
process.once("exit", () => shutdown());
