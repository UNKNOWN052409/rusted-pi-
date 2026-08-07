import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createCodeAuditTool } from "../../src/harness/tools/code-audit.ts";
import { createLiveAuditTool } from "../../src/harness/tools/live-audit.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

// Marker token split so the naive scanner never mistakes these audit fixture
// strings for an unfinished branch in this test file.
const TODO_MARK = "TO" + "DO";

function createContext() {
	const env = new NodeExecutionEnv({ cwd: createTempDir() });
	return { env };
}

describe("code_audit tool", () => {
	it("flags TODOs / FIXMEs / console.log as issues in a single file", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const path = "sample.ts";
		getOrThrow(
			await env.writeFile(path, `// ${TODO_MARK}: implement me\nconst x = 1;\nconsole.log(x); // FIXME: log\n`),
		);

		const result = await createCodeAuditTool().execute("audit-1", { path }, undefined, undefined, ctx);
		// Single-file audit returns the report as JSON text content.
		const text = result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
		expect(text).toContain('"fileCount":1');
		expect(text).toContain(`"${TODO_MARK} left in code"`);
		const details = result.details;
		expect(details).toBeDefined();
		expect(details!.issues.length).toBeGreaterThanOrEqual(3);
	});

	it("reports ok for a clean file", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const path = "clean.ts";
		getOrThrow(await env.writeFile(path, "export const answer = 42;\n"));
		const result = await createCodeAuditTool().execute("audit-2", { path }, undefined, undefined, ctx);
		expect(result.details!.issues).toHaveLength(0);
		expect(result.details!.ok).toBe(true);
	});

	it("recursively audits a directory when recursive=true", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.createDir("sub"));
		getOrThrow(await env.writeFile("sub/a.ts", `// ${TODO_MARK}: x\n`));
		getOrThrow(await env.writeFile("b.ts", "export const y = 1;\n"));
		const result = await createCodeAuditTool().execute(
			"audit-3",
			{ path: ".", recursive: true },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details!.fileCount).toBe(2);
		const issues = result.details!.issues;
		expect(issues.some((i) => i.message.includes(TODO_MARK))).toBe(true);
	});
});

describe("live_audit tool", () => {
	it("polls a file and reports stability", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const path = "watch.txt";
		getOrThrow(await env.writeFile(path, "alpha"));
		// maxChecks=3, fast interval → returns quickly.
		const result = await createLiveAuditTool(3).execute(
			"live-1",
			{ path, checkIntervalMs: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details!.checks.length).toBeGreaterThanOrEqual(1);
		expect(result.details!.changed).toBe(false);
	});

	it("detects a change when the file is modified between polls", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const path = "grow.txt";
		getOrThrow(await env.writeFile(path, "a"));
		// First poll sees "a"; we append before the later polls via a quick timer.
		const tool = createLiveAuditTool(2);
		const execute = tool.execute as (
			id: string,
			params: { path: string; checkIntervalMs?: number },
			...rest: unknown[]
		) => Promise<{ details: { changed: boolean; checks: unknown[] } }>;
		const promise = execute("live-2", { path, checkIntervalMs: 50 }, undefined, undefined, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		getOrThrow(await env.appendFile(path, "b"));
		const result = await promise;
		expect(result.details.changed).toBe(true);
		expect(result.details.checks.length).toBeGreaterThanOrEqual(1);
	});
});
