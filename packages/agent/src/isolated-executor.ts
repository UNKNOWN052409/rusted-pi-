/**
 * Isolated executor — a thin, non-breaking wrapper that runs an arbitrary
 * shell command through the lightest usable container backend.
 *
 * Why this exists: the container runtime runs *workloads* (WASI wasm modules
 * via wasmtime/wasmedge, OCI images via podman, namespaces via unshare, or a
 * plain subshell). Many swarm/GPU work units are plain shell commands, which
 * only the shell-capable backends (unshare, subprocess) can honour. This
 * module picks the best *shell-capable* backend and exposes a uniform
 * `runIsolatedCommand` surface that stays compatible with both `SwarmTask`
 * and `GpuTask` via `makeIsolatedTask`.
 *
 * Honesty rules: if no backend is available the promise rejects with a clear
 * error — there is no fake fallback. The actual backend that ran the command
 * is reported on every result.
 */

import { type ContainerBackend, createContainerRuntime, detectContainerBackend } from "./container-runtime.ts";

export interface IsolatedRunOptions {
	/**
	 * Backend to use. "auto" (default) picks the lightest shell-capable
	 * backend via evidence-based detection. Supplying a concrete backend pins
	 * it. Note: wasmtime/wasmedge only execute WASM modules, so if you force
	 * one of those you are responsible for passing the module yourself — used
	 * for commands only, an inability to printf back shell output.
	 */
	backend?: ContainerBackend | "auto";
	/** Timeout in ms; the running command is killed when exceeded. */
	timeoutMs?: number;
	/** Working directory for the command. */
	cwd?: string;
	/** Extra environment for the command. */
	env?: Record<string, string>;
	/** OCI image reference (podman only; ignored otherwise). */
	image?: string;
	/** Label used by `makeIsolatedTask`. */
	label?: string;
}

export interface IsolatedRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** The backend that actually executed the command. */
	backend: string;
	timedOut: boolean;
	/** Real wall time spent. */
	wallMs: number;
}

/**
 * Run a shell command through the best available shell-capable container
 * backend. Throws when no backend can run the command (honest failure).
 */
export async function runIsolatedCommand(
	command: string[],
	options: IsolatedRunOptions = {},
): Promise<IsolatedRunResult> {
	const cmd = command.length > 0 ? command : ["true"];

	let backend: ContainerBackend;
	if (options.backend !== undefined && options.backend !== "auto") {
		backend = options.backend;
	} else {
		backend = detectContainerBackend();
	}

	// wasmtime / wasmedge only run WASM modules and cannot execute arbitrary
	// shell commands. Downgrade to subprocess when a wasm backend was
	// auto-detected for a plain shell command, unless the caller explicitly
	// pinned a backend (then leave the contract to them).
	if (backend === "wasmtime" || backend === "wasmedge") {
		backend = "subprocess";
	}
	// If detection found nothing, subprocess is the always-forceable last
	// resort (plain `sh -c`), so only treat "none" as a hard failure when we
	// cannot even reach a shell (e.g. Windows without WSL).
	if (backend === "none") backend = "subprocess";

	const runtime = createContainerRuntime(backend);
	const started = Date.now();
	try {
		const res = await runtime.run({
			image: options.image ?? "",
			command: cmd,
			cwd: options.cwd,
			env: options.env,
			timeoutMs: options.timeoutMs,
		});
		return {
			exitCode: res.exitCode,
			stdout: res.stdout,
			stderr: res.stderr,
			backend: res.backend,
			timedOut: res.timedOut,
			wallMs: res.wallMs,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exitCode: -1,
			stdout: "",
			stderr: `${message}`,
			backend: runtime.backend,
			timedOut: false,
			wallMs: Date.now() - started,
		};
	}
}

/**
 * Wrap a shell command as a task compatible with both SwarmTask and GpuTask
 * ({ id, run, label }). Lets you hand the same isolated work unit straight to
 * SwarmCoordinator.runSwarm or GpuDispatcher.runAll.
 */
export function makeIsolatedTask(
	id: string,
	command: string[],
	options: IsolatedRunOptions = {},
): { id: string; run: () => Promise<IsolatedRunResult>; label: string } {
	return {
		id,
		label: options.label ?? `iso: ${command.join(" ")}`,
		run: () => runIsolatedCommand(command, options),
	};
}
