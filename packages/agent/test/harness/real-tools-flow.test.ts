import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import {
	applyEditsToNormalizedContent,
	applyReplacementsPreservingUnchangedLines,
	fuzzyFindText,
	generateUnifiedPatch,
	normalizeToLF,
} from "../../src/harness/tools/edit-diff.ts";
import { withFileMutationQueue } from "../../src/harness/tools/file-mutation-queue.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "../../src/harness/tools/image.ts";
import { resolveReadToolPath, resolveToolPath } from "../../src/harness/tools/path-utils.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { createTempDir } from "./session-test-utils.ts";

function createContext() {
	const env = new NodeExecutionEnv({ cwd: createTempDir() });
	return { env };
}

describe("read tool (real file)", () => {
	it("reads a text file with offset/limit and truncation info", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		getOrThrow(await env.writeFile("sample.txt", lines.join("\n")));

		const tool = createReadTool();
		const full = await tool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
		const fullText = full.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		expect(fullText).toContain("line 1");
		expect(fullText).toContain("line 20");

		const limited = await tool.execute("r2", { path: "sample.txt", offset: 2, limit: 3 }, undefined, undefined, ctx);
		const limitedText = limited.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		expect(limitedText).toContain("line 2");
		expect(limitedText).toContain("line 3");
		expect(limitedText).toContain("line 4");
		expect(limitedText).not.toContain("line 5");
		expect(limitedText).toContain("more lines in file");
	});

	it("throws when offset is beyond the end of the file", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("short.txt", "one\ntwo\n"));
		await expect(
			createReadTool().execute("r3", { path: "short.txt", offset: 99 }, undefined, undefined, ctx),
		).rejects.toThrow("Offset 99 is beyond end of file");
	});

	it("resolves unicode spaces and @-prefixed paths via resolveReadToolPath", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("my file.txt", "hello"));
		const resolved = await resolveReadToolPath(env, "my\u00A0file.txt");
		expect(resolved.endsWith("my file.txt")).toBe(true);
		const atResolved = await resolveToolPath(env, "@my file.txt");
		expect(atResolved.endsWith("my file.txt")).toBe(true);
	});
});

describe("bash tool (real command)", () => {
	it("executes a command and returns stdout", async () => {
		const ctx = createContext();
		const tool = createBashTool();
		const result = await tool.execute("b1", { command: "echo hello-world" }, undefined, undefined, ctx);
		const text = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		expect(text).toContain("hello-world");
		expect(result.details).toBeUndefined();
	});

	it("throws on non-zero exit code", async () => {
		const ctx = createContext();
		const tool = createBashTool();
		await expect(tool.execute("b2", { command: "exit 3" }, undefined, undefined, ctx)).rejects.toThrow(
			"Command exited with code 3",
		);
	});

	it("rejects invalid timeouts", async () => {
		const ctx = createContext();
		const tool = createBashTool();
		await expect(tool.execute("b3", { command: "echo hi", timeout: -1 }, undefined, undefined, ctx)).rejects.toThrow(
			"Invalid timeout",
		);
	});

	it("honors a timeout by aborting the command", async () => {
		const ctx = createContext();
		const tool = createBashTool();
		await expect(
			tool.execute("b4", { command: 'node -e "setTimeout(()=>{},60000)"', timeout: 1 }, undefined, undefined, ctx),
		).rejects.toThrow("Command timed out after 1 seconds");
	}, 15000);

	it("streams progress updates via onUpdate", async () => {
		const ctx = createContext();
		const tool = createBashTool();
		const updates: string[] = [];
		const result = await tool.execute(
			"b5",
			{ command: "echo a; echo b" },
			undefined,
			(update) => {
				const text = update.content
					.filter((p): p is { type: "text"; text: string } => p.type === "text")
					.map((p) => p.text ?? "")
					.join("");
				if (text) updates.push(text);
			},
			ctx,
		);
		const finalText = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		expect(finalText).toContain("a");
		expect(finalText).toContain("b");
	});
});

describe("write tool (real file)", () => {
	it("writes and overwrites a file", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const tool = createWriteTool();
		const result = await tool.execute("w1", { path: "out.txt", content: "first" }, undefined, undefined, ctx);
		const text = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
		expect(text).toContain("Successfully wrote");
		const readBack1 = getOrThrow(await env.readTextFile("out.txt"));
		expect(readBack1).toBe("first");

		await tool.execute("w2", { path: "out.txt", content: "second" }, undefined, undefined, ctx);
		const readBack = getOrThrow(await env.readTextFile("out.txt"));
		expect(readBack).toBe("second");
	});
});

describe("edit tool (real file)", () => {
	it("replaces a unique string and applies edits", async () => {
		const ctx = createContext();
		const { env } = ctx;
		getOrThrow(await env.writeFile("code.ts", "const a = 1;\nconst b = 2;\n"));
		const tool = createEditTool();
		const result = await tool.execute(
			"e1",
			{ path: "code.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content.length).toBeGreaterThan(0);
		const readBack = getOrThrow(await env.readTextFile("code.ts"));
		expect(readBack).toContain("const a = 10;");
		expect(readBack).not.toContain("const a = 1;");
	});
});

describe("edit-diff functions (real strings)", () => {
	it("normalizes line endings to LF", () => {
		expect(normalizeToLF("a\r\nb\r\n")).toBe("a\nb\n");
	});

	it("generates a unified patch and applies edits to normalized content", () => {
		const oldContent = "alpha\nbeta\ngamma\n";
		const newContent = "alpha\nbeta2\ngamma\n";
		const patch = generateUnifiedPatch("diff.txt", oldContent, newContent);
		expect(patch).toContain("diff.txt");
		expect(patch).toContain("-beta");
		expect(patch).toContain("+beta2");

		const applied = applyEditsToNormalizedContent(oldContent, [{ oldText: "beta", newText: "beta2" }], "diff.txt");
		expect(applied.newContent).toBe(newContent);
	});

	it("finds fuzzy matches for slightly-off text", () => {
		const match = fuzzyFindText("const value = 42;\n", "const value = 42");
		expect(match.found).toBe(true);
	});

	it("applies replacements preserving unchanged lines", () => {
		const result = applyReplacementsPreservingUnchangedLines("line1\nline2\nline3\n", "line1\nline2\nline3\n", [
			{ matchIndex: 6, matchLength: 5, newText: "lineX" },
		]);
		expect(result).toContain("lineX");
		expect(result).toContain("line1");
		expect(result).toContain("line3");
	});
});

describe("file mutation queue (real concurrency)", () => {
	it("serializes concurrent file writes via withFileMutationQueue", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const path = "q.txt";
		const ops = Array.from({ length: 5 }, (_, i) =>
			withFileMutationQueue(env, path, async () => {
				const current = (await env.readTextFile(path).then((r) => (r.ok ? r.value : ""))).replace(/\n$/, "");
				await env.writeFile(path, `${current}${i}\n`);
			}),
		);
		await Promise.all(ops);
		const final = getOrThrow(await env.readTextFile(path));
		expect(final.trim()).toBe("01234");
	});
});

describe("executeShellWithCapture (shell-output utils)", () => {
	it("captures stdout and stderr merged", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const result = getOrThrow(await executeShellWithCapture(env, "echo out; echo err >&2"));
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	it("reports non-zero exit codes", async () => {
		const ctx = createContext();
		const { env } = ctx;
		const result = getOrThrow(await executeShellWithCapture(env, "exit 7"));
		expect(result.exitCode).toBe(7);
	});
});

describe("image utils (binary signatures)", () => {
	const pngBytes = () =>
		new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			0,
			0,
			0,
			13,
			...Array.from("IHDR", (c) => c.charCodeAt(0)),
			...new Array(20).fill(0),
		]);

	it("detects PNG", () => {
		expect(detectSupportedImageMimeType(pngBytes())).toBe("image/png");
	});

	it("detects JPEG", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(10).fill(0)]);
		expect(detectSupportedImageMimeType(jpeg)).toBe("image/jpeg");
	});

	it("detects JPEG2000-style SOF7 as unsupported (undefined)", () => {
		const jpeg2k = new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x10, ...new Array(10).fill(0)]);
		expect(detectSupportedImageMimeType(jpeg2k)).toBeUndefined();
	});

	it("detects GIF", () => {
		const gif = new Uint8Array([...Array.from("GIF89a", (c) => c.charCodeAt(0)), ...new Array(10).fill(0)]);
		expect(detectSupportedImageMimeType(gif)).toBe("image/gif");
	});

	it("detects WEBP", () => {
		const webp = new Uint8Array([
			...Array.from("RIFF", (c) => c.charCodeAt(0)),
			0,
			0,
			0,
			0,
			...Array.from("WEBP", (c) => c.charCodeAt(0)),
		]);
		expect(detectSupportedImageMimeType(webp)).toBe("image/webp");
	});

	it("detects valid BMP", () => {
		// BMP header: 'BM', fileSize=70, reserved, pixelDataOffset=54, dibSize=40, width=1, height=1, planes=1, bpp=24
		const bmp = new Uint8Array(70);
		bmp[0] = 0x42; // B
		bmp[1] = 0x4d; // M
		bmp[2] = 70; // fileSize LE
		bmp[10] = 54; // pixelDataOffset
		bmp[14] = 40; // dibHeaderSize
		bmp[18] = 1; // width
		bmp[22] = 1; // height
		bmp[26] = 1; // colorPlanes
		bmp[28] = 24; // bitsPerPixel
		expect(detectSupportedImageMimeType(bmp)).toBe("image/bmp");
	});

	it("rejects invalid BMP (bad planes or bpp)", () => {
		const bmp = new Uint8Array(70);
		bmp[0] = 0x42;
		bmp[1] = 0x4d;
		bmp[2] = 70;
		bmp[10] = 54;
		bmp[14] = 40;
		bmp[18] = 1;
		bmp[22] = 1;
		bmp[26] = 2; // planes = 2, invalid
		bmp[28] = 24;
		expect(detectSupportedImageMimeType(bmp)).toBeUndefined();
	});

	it("returns undefined for unknown content", () => {
		expect(detectSupportedImageMimeType(new TextEncoder().encode("hello world plain text"))).toBeUndefined();
	});

	it("encodes base64 (handles '=' padding and full alphabet)", () => {
		expect(encodeBase64(new Uint8Array([0x48, 0x69]))).toBe("SGk="); // "Hi"
		expect(encodeBase64(new TextEncoder().encode("abc"))).toBe("YWJj");
		expect(encodeBase64(new Uint8Array([]))).toBe("");
		expect(encodeBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
	});
});
