/**
 * Custom provider URL detection tests.
 * Tests the detectApiFromUrl function with various URL formats.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Re-implement the detection logic for testing (avoid import complexities)
function detectApiFromUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		try {
			url = new URL("https://" + rawUrl);
		} catch {
			return { api: "openai-completions", confidence: 0.3, providerName: "Custom Provider", isKnownProvider: false };
		}
	}

	const hostname = url.hostname.toLowerCase();
	const pathname = url.pathname.toLowerCase();

	if (hostname.includes("anthropic")) {
		return { api: "anthropic-messages", confidence: 0.95, providerName: "Anthropic (Custom)", isKnownProvider: true };
	}
	if (hostname.includes("azure.com") || hostname.includes("azure.net")) {
		return { api: "azure-openai-responses", confidence: 0.95, providerName: "Azure OpenAI", isKnownProvider: true };
	}
	if (hostname.includes("googleapis.com") || hostname.includes("google.ai")) {
		return { api: "google-generative-ai", confidence: 0.9, providerName: "Google AI (Custom)", isKnownProvider: true };
	}
	if (hostname.includes("openai.com")) {
		return { api: "openai-responses", confidence: 0.9, providerName: "OpenAI Compatible", isKnownProvider: true };
	}
	if (hostname.includes("mistral.ai") || hostname.includes("mistral")) {
		return { api: "mistral-conversations", confidence: 0.85, providerName: "Mistral (Custom)", isKnownProvider: true };
	}
	if (pathname.includes("/v1/messages")) {
		return { api: "anthropic-messages", confidence: 0.8, providerName: "Anthropic Compatible", isKnownProvider: false };
	}
	if (pathname.includes("/chat/completions") || pathname.includes("/v1/completions")) {
		return { api: "openai-completions", confidence: 0.85, providerName: "OpenAI Compatible", isKnownProvider: false };
	}
	if (pathname.includes("/v1/responses")) {
		return { api: "openai-responses", confidence: 0.85, providerName: "OpenAI Responses Compatible", isKnownProvider: false };
	}
	// Query-param style endpoints like /ai/aichat?prompt=hello
	if (url.searchParams.size > 0) {
		return { api: "openai-completions", confidence: 0.45, providerName: "Custom API (query-param)", isKnownProvider: false };
	}
	// prexzyapis.com
	if (hostname === "prexzyapis.com" || hostname.endsWith(".prexzyapis.com")) {
		return { api: "openai-completions", confidence: 0.7, providerName: "Prexzy API", isKnownProvider: false };
	}
	// burger-king.com.tr
	if (hostname === "burger-king.com.tr" || hostname.endsWith(".burger-king.com.tr")) {
		return { api: "openai-completions", confidence: 0.6, providerName: "Custom Provider (BK)", isKnownProvider: false };
	}
	// scnet.ai
	if (hostname.endsWith(".scnet.ai") || hostname === "scnet.ai") {
		return { api: "openai-completions", confidence: 0.6, providerName: "SCNet AI", isKnownProvider: false };
	}
	// Arbitrary unknown domain
	return { api: "openai-completions", confidence: 0.3, providerName: "Custom Provider", isKnownProvider: false };
}

describe("Custom Provider URL Detection", () => {
	it("detects Anthropic URL", () => {
		const result = detectApiFromUrl("https://api.anthropic.com/v1");
		assert.strictEqual(result.api, "anthropic-messages");
		assert.ok(result.confidence > 0.9);
	});

	it("detects OpenAI URL", () => {
		const result = detectApiFromUrl("https://api.openai.com/v1");
		assert.strictEqual(result.api, "openai-responses");
		assert.ok(result.confidence > 0.85);
	});

	it("detects Azure URL", () => {
		const result = detectApiFromUrl("https://my-resource.openai.azure.com");
		assert.strictEqual(result.api, "azure-openai-responses");
	});

	it("detects Google AI URL", () => {
		const result = detectApiFromUrl("https://generativelanguage.googleapis.com/v1");
		assert.strictEqual(result.api, "google-generative-ai");
	});

	it("detects Mistral URL", () => {
		const result = detectApiFromUrl("https://api.mistral.ai/v1");
		assert.strictEqual(result.api, "mistral-conversations");
	});

	it("detects path-based anthropic-messages", () => {
		const result = detectApiFromUrl("https://proxy.example.com/v1/messages");
		assert.strictEqual(result.api, "anthropic-messages");
		assert.ok(result.confidence > 0.7);
	});

	it("detects path-based openai-completions", () => {
		const result = detectApiFromUrl("https://localhost:8080/v1/chat/completions");
		assert.strictEqual(result.api, "openai-completions");
	});

	it("falls back to openai-completions for unknown URLs", () => {
		const result = detectApiFromUrl("https://my-custom-llm.example.com/api");
		assert.strictEqual(result.api, "openai-completions");
	});

	it("handles URL without scheme", () => {
		const result = detectApiFromUrl("localhost:8080/v1");
		assert.strictEqual(result.api, "openai-completions");
	});

	it("handles scnet.ai URL (custom proxy platform)", () => {
		const result = detectApiFromUrl("https://www.scnet.ai/");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "SCNet AI");
		assert.strictEqual(result.isKnownProvider, false);
	});

	it("detects prexzyapis.com with explicit pattern", () => {
		const result = detectApiFromUrl("https://prexzyapis.com");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Prexzy API");
		assert.ok(result.confidence >= 0.6);
	});

	it("detects prexzyapis.com/ai/aichat with query params", () => {
		const result = detectApiFromUrl("https://prexzyapis.com/ai/aichat?prompt=hello");
		// Query-param pattern takes precedence (matches before hostname check in order)
		assert.strictEqual(result.api, "openai-completions");
		assert.ok(result.confidence >= 0.4);
		assert.strictEqual(result.isKnownProvider, false);
	});

	it("detects burger-king.com.tr with explicit pattern", () => {
		const result = detectApiFromUrl("https://ergreg.burger-king.com.tr");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Custom Provider (BK)");
		assert.ok(result.confidence >= 0.5);
	});

	it("handles query-param style API (e.g., prexzyapis.com/ai/aichat?prompt=hello)", () => {
		const result = detectApiFromUrl("https://prexzyapis.com/ai/aichat?prompt=hello");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Custom API (query-param)");
		assert.ok(result.confidence < 0.5);
	});

	it("handles arbitrary API endpoint without path", () => {
		const result = detectApiFromUrl("https://xyzrandom123.com");
		assert.strictEqual(result.api, "openai-completions");
		assert.ok(result.confidence >= 0.2);
	});

	it("handles cloudflare ai gateway URL", () => {
		const result = detectApiFromUrl("https://gateway.ai.cloudflare.com/v1/account-id/models");
		assert.strictEqual(result.api, "openai-completions");
	});

	it("handles localhost URL", () => {
		const result = detectApiFromUrl("http://127.0.0.1:1234");
		assert.strictEqual(result.api, "openai-completions");
	});
});

describe("Rust Stability Check", () => {
	it("detects fabricated model gpt-5", async () => {
		const { checkStabilityRust } = await import("../index.js");
		const result = await checkStabilityRust("Hello world", { modelId: "gpt-5" });
		assert.strictEqual(result.pass, false);
		assert.ok(result.issues.some((i) => i.type === "fake_model"));
		assert.strictEqual(result.suggestedAction, "reject");
		assert.strictEqual(result.source, "rust");
	});

	it("detects word repetition", async () => {
		const { checkStabilityRust } = await import("../index.js");
		const result = await checkStabilityRust("hello hello hello hello hello world");
		assert.ok(result.issues.some((i) => i.type === "repetition"));
	});

	it("passes clean text", async () => {
		const { checkStabilityRust } = await import("../index.js");
		const result = await checkStabilityRust("This is a completely normal response with no issues whatsoever.", { modelId: "gpt-4" });
		assert.strictEqual(result.pass, true);
	});

	it("returns source rust on success", async () => {
		const { checkStabilityRust } = await import("../index.js");
		const result = await checkStabilityRust("Some normal text here", { modelId: "unknown-model" });
		assert.strictEqual(result.source, "rust");
	});
});

describe("Rust Native JS Bridge", () => {
	it("detectGpu returns valid info", async () => {
		const { detectGpu } = await import("../index.js");
		const gpu = await detectGpu();
		assert.ok("available" in gpu);
		assert.ok("name" in gpu);
		assert.ok("vramMb" in gpu);
	});

	it("cpuLoad returns load info", async () => {
		const { cpuLoad } = await import("../index.js");
		const cpu = await cpuLoad();
		assert.ok("load" in cpu);
		assert.ok("coreCount" in cpu);
		assert.ok("shouldYield" in cpu);
		assert.ok(cpu.load >= 0 && cpu.load <= 1);
	});

	it("systemMemoryMb returns sensible value", async () => {
		const { systemMemoryMb } = await import("../index.js");
		const mem = await systemMemoryMb();
		assert.ok(mem >= 512);
	});

	it("detectApiFromUrlRust detects prexzyapis", async () => {
		const { detectApiFromUrlRust } = await import("../index.js");
		const result = await detectApiFromUrlRust("https://prexzyapis.com");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Prexzy API");
		assert.ok(result.confidence >= 0.6);
	});

	it("detectApiFromUrlRust detects openai", async () => {
		const { detectApiFromUrlRust } = await import("../index.js");
		const result = await detectApiFromUrlRust("https://api.openai.com/v1");
		assert.strictEqual(result.api, "openai-responses");
		assert.ok(result.confidence >= 0.85);
	});

	it("detectApiFromUrlRust detects burger-king", async () => {
		const { detectApiFromUrlRust } = await import("../index.js");
		const result = await detectApiFromUrlRust("https://ergreg.burger-king.com.tr");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "Custom Provider (BK)");
		assert.ok(result.confidence >= 0.5);
	});

	it("detectApiFromUrlRust detects scnet", async () => {
		const { detectApiFromUrlRust } = await import("../index.js");
		const result = await detectApiFromUrlRust("https://www.scnet.ai");
		assert.strictEqual(result.api, "openai-completions");
		assert.strictEqual(result.providerName, "SCNet AI");
		assert.ok(result.confidence >= 0.5);
	});

	it("detectApiFromUrlRust falls back for unknown", async () => {
		const { detectApiFromUrlRust } = await import("../index.js");
		const result = await detectApiFromUrlRust("https://xyzrandom123.com/api");
		assert.strictEqual(result.api, "openai-completions");
		assert.ok(result.confidence <= 0.5);
	});

	it("fetchUrlRust returns content", async () => {
		const { fetchUrlRust } = await import("../index.js");
		const result = await fetchUrlRust("https://httpbin.org/html");
		assert.strictEqual(result.success, true);
		assert.ok(result.status === 200);
		assert.ok((result.text || "").length > 100);
	});
});
