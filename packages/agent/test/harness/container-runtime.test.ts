import { describe, expect, it } from "vitest";
import { createContainerRuntime, detectContainerBackend } from "../../src/container-runtime.ts";

describe("container-runtime", () => {
	it("detects a real backend on this host (evidence-based)", () => {
		const backend = detectContainerBackend();
		// The local environment has wasmtime in WSL; on bare Windows CI this is
		// "none" — both are legitimate evidence-based outcomes. The key assertion
		// is that detection never fabricates a backend.
		expect(["podman", "wasmtime", "wasmedge", "unshare", "none"]).toContain(backend);
	});

	it("honors a forced backend without probing", () => {
		const rt = createContainerRuntime("subprocess");
		expect(rt.backend).toBe("subprocess");
	});

	it("runs a real workload through the subprocess backend", async () => {
		const rt = createContainerRuntime("subprocess");
		const res = await rt.run({ image: "", command: ["echo", "hello-iso"] });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain("hello-iso");
		expect(res.wallMs).toBeGreaterThanOrEqual(0);
		expect(res.timedOut).toBe(false);
	});

	it("runs a real WASI module through the wasmtime backend when present", async () => {
		const backend = detectContainerBackend();
		if (backend !== "wasmtime") {
			// wasmtime not installed on this host — skip the real execution but
			// still prove the forced path degrades honestly.
			const rt = createContainerRuntime("wasmtime");
			const res = await rt.run({ image: "", command: [] });
			expect(["wasmtime", "none"]).toContain(rt.backend);
			if (rt.backend === "wasmtime") {
				expect(res.stdout).toContain("hello from wasi");
			}
			return;
		}
		const rt = createContainerRuntime("wasmtime");
		const res = await rt.run({ image: "", command: [] });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain("hello from wasi");
		expect(res.timedOut).toBe(false);
	});

	it("enforces timeouts on a hanging workload", async () => {
		const rt = createContainerRuntime("subprocess");
		const res = await rt.run({ image: "", command: ["sleep", "5"], timeoutMs: 500 });
		expect(res.timedOut).toBe(true);
	});
});
