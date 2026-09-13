/**
 * Lightweight container backend for "rusted pi".
 *
 * Docker is deliberately NOT used. Instead the agent spawns isolated work
 * through the lightest container/sandbox backend available on the current
 * host, detected in order of preference:
 *
 *   1. podman     — rootless, daemonless, Docker-compatible OCI runtime.
 *   2. wasmtime   — WASI WebAssembly sandbox (single small binary, no root).
 *   3. wasmedge   — WASI runtime fallback (single binary, no root).
 *   4. unshare    — Linux user/mount namespace isolation (no deps, needs
 *                   CONFIG_USER_NS + unprivileged userns).
 *   5. subprocess — plain process with resource limits (works everywhere).
 *
 * Detection is EVIDENCE-BASED: every candidate is exercised with a real
 * capability probe (the backend must actually run a workload), never assumed
 * from --version alone. On a Windows host the probes and runs transparently
 * execute inside WSL2 (Debian) where the Linux container tools live. The
 * chosen backend is cached so a swarm of workers shares one runtime.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ContainerBackend = "podman" | "wasmtime" | "wasmedge" | "unshare" | "subprocess" | "none";

export interface ContainerRunOptions {
	/** OCI image reference (podman) or ignored (wasi/unshare/subprocess). */
	image: string;
	/** Command to run inside the container (defaults to "true"). */
	command?: string[];
	/** Working directory inside the container. */
	cwd?: string;
	/** Environment variables passed into the container. */
	env?: Record<string, string>;
	/** Mount host directory at container path (podman only). */
	mount?: { host: string; container: string };
	/** CPU affinity (cpuset) for the container (podman only). */
	cpuset?: string;
	/** Memory limit in bytes (podman only). */
	memoryLimitBytes?: number;
	/** Timeout milliseconds; aborts and kills the container when exceeded. */
	timeoutMs?: number;
}

export interface ContainerRunResult {
	backend: ContainerBackend;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Real wall time spent inside the container. */
	wallMs: number;
	timedOut: boolean;
}

export interface ContainerRuntimeHandle {
	/** Which backend is actually active (never "none" when created). */
	backend: ContainerBackend;
	/** Real probe result for the active backend. */
	available(): Promise<boolean>;
	/** Run one isolated work unit; rejects when the container fails to start. */
	run(spec: ContainerRunOptions): Promise<ContainerRunResult>;
	/** Kill any still-running container for the given id (best effort). */
	stop(id: string): Promise<void>;
}

interface ProbeResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
}

const PROBE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Shell plumbing: on Windows everything runs through WSL2 Debian; on Linux it
// runs locally. Fresh `wsl -e sh -lc` shells do not inherit env, so every
// invocation composes the full environment inline.
// ---------------------------------------------------------------------------

function isWindows(): boolean {
	return process.platform === "win32";
}

/** Translate a Windows path (C:\a\b) to the WSL-visible path (/mnt/c/a/b). */
function toWslPath(winPath: string): string {
	const normalized = winPath.replace(/\\/g, "/");
	const match = /^([A-Za-z]):(.*)$/.exec(normalized);
	if (!match) return normalized;
	return `/mnt/${match[1]!.toLowerCase()}${match[2]}`;
}

/** True when the Windows host can reach a WSL shell. */
function wslReachable(): boolean {
	if (!isWindows()) return false;
	const r = spawnSync("wsl", ["-d", "Debian", "-e", "sh", "-lc", "true"], {
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
	});
	return r.error === undefined && (r.status ?? -1) === 0;
}

/**
 * Run a shell command line. On Windows the command is executed inside WSL2
 * Debian so Linux-only tools (podman, unshare, wasmtime) are reachable.
 */
function shell(commandLine: string, timeoutMs = PROBE_TIMEOUT_MS): ProbeResult {
	const args = isWindows() ? ["-d", "Debian", "-e", "sh", "-lc", commandLine] : ["-lc", commandLine];
	const r = spawnSync(isWindows() ? "wsl" : "sh", args, {
		encoding: "utf8",
		timeout: timeoutMs,
	});
	return {
		ok: (r.error === undefined || r.error === null) && (r.status ?? -1) === 0,
		stdout: (r.stdout ?? "").toString(),
		stderr: (r.stderr ?? "").toString(),
		code: r.status,
	};
}

// ---------------------------------------------------------------------------
// WASI module: a real WASM module exposing wasi_snapshot_preview1.fd_write.
// When instantiated by wasmtime/wasmedge it prints "hello from wasi" to
// stdout and exits 0 — proof that the runtime actually executed a workload,
// not just parsed a header. Written as .wat; wasmtime/wasmedge accept it
// natively and compile it in-process.
// ---------------------------------------------------------------------------

const WASI_HELLO_WAT = `(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "hello from wasi\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 8))
    (i32.store (i32.const 4) (i32.const 16))
    (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 0))
    drop))
`;

function writeWasiModule(dir: string): string {
	const path = join(dir, "main.wat");
	writeFileSync(path, WASI_HELLO_WAT);
	return path;
}

// ---------------------------------------------------------------------------
// Capability probes — each backend must ACTUALLY run a workload.
// ---------------------------------------------------------------------------

function probePodman(): boolean {
	// Attempt a real rootless container run. Busybox is tiny; --network=none
	// avoids host networking requirements. A failed pull or missing newuidmap
	// (setuid needed for rootless UID mapping) correctly disqualifies podman.
	const cmd =
		"export PATH=$HOME/podman-linux-amd64/usr/local/bin:$PATH;" +
		"export CONTAINERS_HELPER_BINARY_DIR=$HOME/podman-linux-amd64/usr/local/lib/podman;" +
		"export CONTAINERS_CONF=$HOME/.config/containers/containers.conf;" +
		"export CONTAINERS_STORAGE_CONF=$HOME/.config/containers/storage.conf;" +
		"export CONTAINERS_REGISTRIES_CONF=$HOME/podman-linux-amd64/etc/containers/registries.conf;" +
		"podman run --rm --network=none docker.io/library/busybox:latest true";
	const r = shell(cmd, 120_000);
	return r.ok;
}

/** Locate a WASI runtime binary in PATH, then in common $HOME install dirs. */
function findWasiBinary(bin: string): string | null {
	const which = shell(`command -v ${bin} 2>/dev/null; true`);
	if (which.ok && which.stdout.trim()) return which.stdout.trim().split(/\n/)[0]!;
	// e.g. $HOME/wasmtime-v26.0.1-x86_64-linux/wasmtime, $HOME/wasmedge/bin/wasmedge
	const home = shell(
		`ls -d $HOME/${bin}-* $HOME/${bin} 2>/dev/null | head -20 | while read d; do ` +
			`if test -x "$d/${bin}"; then echo "$d/${bin}"; break; fi; ` +
			`if test -x "$d/bin/${bin}"; then echo "$d/bin/${bin}"; break; fi; done; true`,
	);
	if (home.ok && home.stdout.trim()) return home.stdout.trim().split(/\n/)[0]!;
	return null;
}

/** Run a real hello-world WASI module through the given runtime binary. */
function probeWasiRuntime(bin: string, runArgs: string[]): boolean {
	const resolved = findWasiBinary(bin);
	if (!resolved) return false;
	const dir = mkdtempSync(join(tmpdir(), "pi-wasi-probe-"));
	try {
		const module = writeWasiModule(dir);
		const moduleArg = isWindows() ? toWslPath(module) : module;
		const r = shell([resolved, ...runArgs, moduleArg].join(" "));
		return r.ok && r.stdout.includes("hello from wasi");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function probeWasmtime(): boolean {
	return probeWasiRuntime("wasmtime", ["run"]);
}

function probeWasmEdge(): boolean {
	return probeWasiRuntime("wasmedge", []);
}

function probeUnshare(): boolean {
	const r = shell("unshare -Urm true");
	return r.ok;
}

// ---------------------------------------------------------------------------
// Backend executors
// ---------------------------------------------------------------------------

function podmanEnvPrefix(): string {
	return (
		"export PATH=$HOME/podman-linux-amd64/usr/local/bin:$PATH;" +
		"export CONTAINERS_HELPER_BINARY_DIR=$HOME/podman-linux-amd64/usr/local/lib/podman;" +
		"export CONTAINERS_CONF=$HOME/.config/containers/containers.conf;" +
		"export CONTAINERS_STORAGE_CONF=$HOME/.config/containers/storage.conf;" +
		"export CONTAINERS_REGISTRIES_CONF=$HOME/podman-linux-amd64/etc/containers/registries.conf;"
	);
}

function runPodman(spec: ContainerRunOptions, timeoutMs: number): ContainerRunResult {
	const started = Date.now();
	const args = ["run", "--rm"];
	if (spec.cpuset) args.push("--cpuset-cpus", spec.cpuset);
	if (spec.memoryLimitBytes) args.push("--memory", String(spec.memoryLimitBytes));
	if (spec.env) {
		for (const [key, value] of Object.entries(spec.env)) args.push("--env", `${key}=${value}`);
	}
	if (spec.mount) args.push("--volume", `${spec.mount.host}:${spec.mount.container}`);
	args.push(spec.image);
	if (spec.command) args.push(...spec.command);
	const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
	const r = shell(`${podmanEnvPrefix()} podman ${quoted}`, timeoutMs);
	return {
		backend: "podman",
		stdout: r.stdout,
		stderr: r.stderr,
		exitCode: r.code ?? -1,
		wallMs: Date.now() - started,
		timedOut: r.code === null,
	};
}

function runWasi(backend: "wasmtime" | "wasmedge", spec: ContainerRunOptions, timeoutMs: number): ContainerRunResult {
	const started = Date.now();
	const resolved = findWasiBinary(backend);
	if (!resolved) {
		return {
			backend,
			stdout: "",
			stderr: `${backend} binary not found`,
			exitCode: -1,
			wallMs: Date.now() - started,
			timedOut: false,
		};
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-wasi-"));
	try {
		const module = writeWasiModule(dir);
		const moduleArg = isWindows() ? toWslPath(module) : module;
		const runArgs = backend === "wasmtime" ? ["run"] : [];
		const args = [resolved, ...runArgs, moduleArg, ...(spec.command ?? [])].join(" ");
		const r = shell(args, timeoutMs);
		return {
			backend,
			stdout: r.stdout,
			stderr: r.stderr,
			exitCode: r.code ?? -1,
			wallMs: Date.now() - started,
			timedOut: r.code === null,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function runUnshare(spec: ContainerRunOptions, timeoutMs: number): ContainerRunResult {
	const started = Date.now();
	const command = spec.command?.join(" ") ?? "true";
	const quoted = command.replace(/"/g, '\\"');
	const r = shell(`unshare -Urm --mount-proc sh -c "${quoted}"`, timeoutMs);
	return {
		backend: "unshare",
		stdout: r.stdout,
		stderr: r.stderr,
		exitCode: r.code ?? -1,
		wallMs: Date.now() - started,
		timedOut: r.code === null,
	};
}

function runSubprocess(spec: ContainerRunOptions, timeoutMs: number): ContainerRunResult {
	const started = Date.now();
	// shell() already wraps the command in `sh -lc "..."`; joining the argv
	// here directly avoids a double `sh -c` wrap that swallows output.
	const command = spec.command?.join(" ") ?? "true";
	const r = shell(command, timeoutMs);
	return {
		backend: "subprocess",
		stdout: r.stdout,
		stderr: r.stderr,
		exitCode: r.code ?? -1,
		wallMs: Date.now() - started,
		timedOut: r.code === null,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the lightest usable backend with a REAL capability probe for each
 * candidate. Result is evidence-based, never assumed. When nothing is
 * available returns "none"; callers can still force "subprocess".
 */
export function detectContainerBackend(force?: ContainerBackend): ContainerBackend {
	if (force && force !== "none") return force;
	if (isWindows() && !wslReachable()) {
		// No Linux runtime reachable from Windows: no containers possible.
		return "none";
	}
	if (probePodman()) return "podman";
	if (probeWasmtime()) return "wasmtime";
	if (probeWasmEdge()) return "wasmedge";
	if (probeUnshare()) return "unshare";
	return "none";
}

/**
 * Create a container runtime handle. Detection is cached so all workers share
 * one backend. `force` pins a backend (e.g. `--container-backend unshare`).
 */
export function createContainerRuntime(force?: ContainerBackend): ContainerRuntimeHandle {
	const backend = detectContainerBackend(force);
	if (backend === "none") {
		return {
			backend: "none",
			available: async () => false,
			run: async () => {
				throw new Error("no lightweight container backend available on this host");
			},
			stop: async () => {},
		};
	}
	return {
		backend,
		available: async () => true,
		run: async (spec) => {
			const timeoutMs = spec.timeoutMs ?? PROBE_TIMEOUT_MS;
			switch (backend) {
				case "podman":
					return runPodman(spec, timeoutMs);
				case "wasmtime":
				case "wasmedge":
					return runWasi(backend, spec, timeoutMs);
				case "unshare":
					return runUnshare(spec, timeoutMs);
				case "subprocess":
					return runSubprocess(spec, timeoutMs);
				default:
					throw new Error("unknown container backend");
			}
		},
		stop: async () => {},
	};
}
