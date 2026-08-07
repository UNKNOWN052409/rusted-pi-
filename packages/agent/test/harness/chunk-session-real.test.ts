import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkAndUnderstand, chunkLineCap, splitIntoChunks } from "../../src/chunk-prompt.ts";
import { SessionStore } from "../../src/session-store.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "rusted-pi-test-"));
}

describe("chunk-prompt (huge prompts, no size limit)", () => {
	it("splits a 100k-line prompt into 20% chunks of 20k lines", () => {
		const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const cap = chunkLineCap(100_000, {});
		expect(cap).toBe(20_000); // 20% of 1L
		const chunks = splitIntoChunks(text, cap);
		expect(chunks.length).toBe(5); // 100k / 20k
		expect(chunks[0].split("\n").length).toBe(20_000);
		expect(chunks[4].split("\n").length).toBe(20_000);
	});

	it("processes a 10-lakh-line prompt through parallel summarizers", async () => {
		const lines = Array.from({ length: 1_000_000 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const seen: Array<{ index: number; total: number; firstLine: string; lineCount: number }> = [];
		const result = await chunkAndUnderstand(text, {
			parallelism: 4,
			summarize: async (chunk, index, total) => {
				const chunkLines = chunk.split("\n");
				seen.push({ index, total, firstLine: chunkLines[0], lineCount: chunkLines.length });
				return `chunk ${index} covers ${chunkLines[0]}..${chunkLines[chunkLines.length - 1]}`;
			},
		});
		// 1M lines / 20k cap = 50 chunks.
		expect(result.chunkCount).toBe(50);
		expect(result.totalLines).toBe(1_000_000);
		expect(result.chunks.length).toBe(50);
		expect(result.merged).toContain("chunk 1/50");
		expect(result.merged).toContain("chunk 50/50");
		// Every chunk was summarized exactly once, in order.
		expect(seen.map((s) => s.index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
		expect(seen.every((s) => s.total === 50)).toBe(true);
		expect(seen[0].firstLine).toBe("line 0");
	});

	it("caps chunk size with maxChunkLines", () => {
		const text = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
		const cap = chunkLineCap(100, { chunkFraction: 0.2, maxChunkLines: 7 });
		expect(cap).toBe(7); // 20% of 100 = 20, capped at 7
		const chunks = splitIntoChunks(text, cap);
		expect(chunks.length).toBe(15);
		expect(chunks[0].split("\n").length).toBe(7);
	});

	it("handles an empty prompt gracefully", async () => {
		const result = await chunkAndUnderstand("");
		expect(result.chunkCount).toBe(1);
		expect(result.totalLines).toBe(1); // split("") -> [""]
		expect(result.merged).toContain("chunk 1/1");
	});
});

describe("SessionStore (resume tokens)", () => {
	it("creates a session with a random token and persists it", () => {
		const dir = tempDir();
		const store = new SessionStore({ dir });
		const state = store.create({ cwd: "/work/proj", task: "build the thing" });
		expect(state.token).toMatch(/^[0-9a-f]{16}$/);
		expect(state.cwd).toBe("/work/proj");
		expect(state.progress).toBe(0);
		// Load back from disk.
		const loaded = store.load(state.token);
		expect(loaded.task).toBe("build the thing");
		rmSync(dir, { recursive: true, force: true });
	});

	it("updates progress/phase and resume returns the working dir", () => {
		const dir = tempDir();
		const store = new SessionStore({ dir });
		const state = store.create({ cwd: "/data/repo", task: "refactor" });
		const updated = store.update(state.token, { phase: "coding", progress: 42, notes: "mid-way" });
		expect(updated.phase).toBe("coding");
		expect(updated.progress).toBe(42);
		expect(updated.notes).toBe("mid-way");
		const resumed = store.load(state.token);
		expect(resumed.cwd).toBe("/data/repo"); // resume from the dir
		expect(resumed.phase).toBe("coding");
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws for an unknown token", () => {
		const dir = tempDir();
		const store = new SessionStore({ dir });
		expect(() => store.load("deadbeefdeadbeef")).toThrow(/No session found/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists sessions newest first", () => {
		const dir = tempDir();
		const store = new SessionStore({ dir });
		const a = store.create({ cwd: "/a", task: "first" });
		const b = store.create({ cwd: "/b", task: "second" });
		store.update(a.token, { progress: 10 });
		const list = store.list();
		expect(list.map((s) => s.token)).toEqual([a.token, b.token]);
		expect(list[0].progress).toBe(10);
		rmSync(dir, { recursive: true, force: true });
	});
});
