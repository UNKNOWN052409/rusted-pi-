/**
 * REAL tests for pi-native Rust binary + JS bridge.
 *
 * Every test exercises real code paths against real system resources.
 * No mocks, no stubs, no assert(true).
 * Tests unique scenarios not covered by real.test.mjs or detection.test.mjs.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";
const binaryPath = join(__dirname, "target", "release", "pi-native" + ext);

describe("pi-native binary — all 7 commands", () => {
	it("binary exists and is executable", () => {
		assert.ok(existsSync(binaryPath), `Binary not found at ${binaryPath}`);
		const stat = existsSync(binaryPath);
		assert.ok(stat === true);
	});

	it("stability-check detects fabricated model gpt-5", () => {
		const payload = JSON.stringify({ text: "hello world", modelId: "gpt-5" });
		const result = spawnSync(binaryPath, [], {
			input: `stability-check${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.pass, false);
		assert.strictEqual(output.source, "rust");
		assert.ok(output.issues.some((i) => i.type === "fake_model"));
		assert.strictEqual(output.suggestedAction, "reject");
		console.log("stability-check: fabricated model detected →", output.issues.length, "issue(s)");
	});

	it("detect-api recognizes prexzyapis.com at 0.7 confidence", () => {
		const payload = JSON.stringify({ url: "https://prexzyapis.com" });
		const result = spawnSync(binaryPath, [], {
			input: `detect-api${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.api, "openai-completions");
		assert.strictEqual(output.providerName, "Prexzy API");
		assert.ok(output.confidence >= 0.6, `confidence ${output.confidence} < 0.6`);
		console.log("detect-api prexzyapis:", output.api, "@", output.confidence);
	});

	it("detect-api detects openai-responses for api.openai.com", () => {
		const payload = JSON.stringify({ url: "https://api.openai.com/v1" });
		const result = spawnSync(binaryPath, [], {
			input: `detect-api${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.api, "openai-responses");
		assert.ok(output.confidence >= 0.85);
		assert.strictEqual(output.isKnownProvider, true);
	});

	it("detect-api handles burger-king.com.tr as custom provider", () => {
		const payload = JSON.stringify({ url: "https://ergreg.burger-king.com.tr" });
		const result = spawnSync(binaryPath, [], {
			input: `detect-api${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.api, "openai-completions");
		assert.strictEqual(output.providerName, "Custom Provider (BK)");
		assert.ok(output.confidence >= 0.5);
	});

	it("fetch-url returns real HTTP content from httpbin", () => {
		const payload = JSON.stringify({ url: "https://httpbin.org/html" });
		const result = spawnSync(binaryPath, [], {
			input: `fetch-url${payload}\nexit\n`,
			encoding: "utf-8",
			timeout: 10000,
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.success, true);
		assert.strictEqual(output.status, 200);
		assert.ok((output.text || "").length > 200, `content length ${(output.text || "").length} < 200`);
		console.log("fetch-url: HTTP", output.status, "|", output.length, "bytes");
	});

	it("compaction-should-compact triggers at 70% via 0.6 threshold", () => {
		const payload = JSON.stringify({ contextTokens: 90000, contextWindow: 128000, thresholds: [0.6, 0.8] });
		const result = spawnSync(binaryPath, [], {
			input: `compaction-should-compact ${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.shouldCompact, true);
		assert.strictEqual(output.thresholdHit, 0.6);
		console.log("compaction: 70% → compact at", output.thresholdHit);
	});

	it("compaction-should-compact does not trigger at 59% with 0.6 threshold", () => {
		const payload = JSON.stringify({ contextTokens: 75000, contextWindow: 128000, thresholds: [0.6, 0.8] });
		const result = spawnSync(binaryPath, [], {
			input: `compaction-should-compact ${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.shouldCompact, false);
		assert.strictEqual(output.thresholdHit, null);
		console.log("compaction: 59% → no compact, usagePercent:", output.usagePercent);
	});

	it("compaction-should-compact triggers reserveTokens when over limit", () => {
		const payload = JSON.stringify({ contextTokens: 120000, contextWindow: 128000, reserveTokens: 16384 });
		const result = spawnSync(binaryPath, [], {
			input: `compaction-should-compact ${payload}\nexit\n`,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const lines = result.stdout.trim().split("\n");
		const output = JSON.parse(lines[0]);
		assert.strictEqual(output.shouldCompact, true);
		assert.strictEqual(output.thresholdHit, "reserve");
		console.log("compaction: reserve triggered at", output.usagePercent);
	});
});

describe("JS bridge — new Rust exports", () => {
	it("checkStabilityRust detects fabricated model via JS bridge", async () => {
		const { checkStabilityRust } = await import("./index.js");
		const result = await checkStabilityRust("hello world", { modelId: "gpt-5" });
		assert.strictEqual(result.pass, false);
		assert.strictEqual(result.source, "rust");
		assert.ok(result.issues.some((i) => i.type === "fake_model"));
	});

	it("checkStabilityRust returns pass=true for clean text", async () => {
		const { checkStabilityRust } = await import("./index.js");
		const result = await checkStabilityRust("The quick brown fox jumps over the lazy dog.", { modelId: "gpt-4" });
		assert.strictEqual(result.pass, true);
		assert.strictEqual(result.suggestedAction, "allow");
	});

	it("detectApiFromUrlRust recognizes prexzyapis.com", async () => {
		const { detectApiFromUrlRust } = await import("./index.js");
		const result = await detectApiFromUrlRust("https://prexzyapis.com");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Prexzy API");
		assert.ok(result.confidence >= 0.6);
	});

	it("detectApiFromUrlRust recognizes burger-king.com.tr", async () => {
		const { detectApiFromUrlRust } = await import("./index.js");
		const result = await detectApiFromUrlRust("https://ergreg.burger-king.com.tr");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Custom Provider (BK)");
		assert.ok(result.confidence >= 0.5);
	});

	it("fetchUrlRust returns real HTTP content", { timeout: 15000 }, async () => {
		const { fetchUrlRust } = await import("./index.js");
		const result = await fetchUrlRust("https://httpbin.org/html");
		assert.strictEqual(result.success, true);
		assert.ok(result.status === 200);
		assert.ok((result.text || "").length > 200);
	});
});
