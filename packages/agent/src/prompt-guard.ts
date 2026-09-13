/**
 * Prompt guard — origin-aware.
 *
 * Some OpenAI-compatible proxies rewrite or inject content into the system
 * prompt: "You are Claude", "pretend to be X", "respond in one line", or
 * chunk-streaming directives. This module detects and strips those injections
 * — but only when the prompt arrives from an untrusted source ("api"). A
 * prompt the user typed or configured ("user") is always legitimate, whatever
 * its style — personality, role, system design — and is never filtered.
 */

/** Where the prompt came from. Decides whether guard rules apply. */
export type PromptOrigin = "user" | "api";

/** A stripped injection, for audit trails. */
export interface GuardFinding {
	/** Matched snippet kind, e.g. "identity-override" or "format-forcing". */
	kind: string;
	/** The removed line (trimmed). */
	line: string;
}

export interface GuardResult {
	/** Cleaned prompt (injection lines removed, user rules intact). */
	prompt: string;
	/** Everything that was removed. */
	findings: GuardFinding[];
}

/**
 * Patterns for proxy-injected directives, matched line-by-line outside user
 * rules blocks. Matches are anchored on directive phrasing; ordinary prose,
 * code, and user instructions never match.
 */
const INJECTION_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
	{
		kind: "identity-override",
		pattern: /^\s*(?:you are(?: now)?|pretend(?: that)? you are|act as if you are|behave as(?: if)? claude)\b/i,
	},
	{
		kind: "format-forcing",
		pattern:
			/^\s*(?:respond|reply|answer)(?: only)? (?:in|with) (?:a )?(?:single line|one line|1 line|one word|single word)\b/i,
	},
	{
		kind: "chunk-protocol",
		pattern: /^\s*(?:return|output|emit|send) (?:your )?(?:response|answer|output) in chunks?\b/i,
	},
	{ kind: "chunk-protocol", pattern: /^\s*chunk(?:ed)? (?:response|output|streaming) protocol\b/i },
	{ kind: "secrecy", pattern: /^\s*(?:do not|don'?t) (?:tell|reveal|mention|say) (?:the user|anyone)\b/i },
];

/**
 * Markers that open a user-rules block. Once inside, every line is user
 * content: AGENTS.md, RULES.md, role declarations, system designs — all kept
 * verbatim regardless of phrasing.
 */
const RULES_BLOCK_OPENERS: RegExp[] = [
	/^\s*(?:<!--\s*)?(?:the following (?:is |are )?(?:from |contents of )?)?\s*(?:AGENTS\.md|RULES?\.md|RULES?|SYSTEM (?:DESIGN|PROMPT))(?:\s*-->)?\s*:?\s*(?:-->|starts? here|follows|below)?\s*$/i,
	/^\s*```\s*(?:agents|rules|system)\s*$/i,
];

/** Fenced block close (only tracked when the block opened with a fence). */
const FENCE_CLOSE = /^\s*```\s*$/;

/**
 * Guard a prompt against proxy injections.
 *
 * `origin` decides whether any filtering happens:
 * - "user": the prompt is trusted by definition — it is returned verbatim
 *   with no findings. Every user has their own way of using the model (role
 *   play, personality, system design); none of it is an injection.
 * - "api" (default): untrusted content (proxy-injected system prompt, remote
 *   instructions) is scanned; known injection lines are removed while any
 *   embedded user rule files (AGENTS.md, RULES.md, fenced role blocks) are
 *   preserved verbatim.
 */
export function guardPrompt(prompt: string, origin: PromptOrigin = "api"): GuardResult {
	if (origin === "user") return { prompt, findings: [] };

	const lines = prompt.split(/\r?\n/);
	const findings: GuardFinding[] = [];
	const kept: string[] = [];

	let inRulesBlock = false;
	let fencedRulesBlock = false;

	for (const line of lines) {
		if (inRulesBlock) {
			kept.push(line);
			if (fencedRulesBlock && FENCE_CLOSE.test(line)) {
				inRulesBlock = false;
				fencedRulesBlock = false;
			}
			continue;
		}

		const opener = RULES_BLOCK_OPENERS.find((p) => p.test(line));
		if (opener) {
			inRulesBlock = true;
			fencedRulesBlock = /^\s*```/.test(line);
			kept.push(line);
			continue;
		}

		let stripped = false;
		for (const { kind, pattern } of INJECTION_PATTERNS) {
			if (pattern.test(line)) {
				findings.push({ kind, line: line.trim() });
				stripped = true;
				break;
			}
		}
		if (!stripped) kept.push(line);
	}

	return { prompt: kept.join("\n"), findings };
}

/**
 * True when the prompt contains no known proxy injections.
 * Cheap pre-check for harness middleware: skip rewriting clean prompts.
 * User-origin prompts are always clean.
 */
export function isCleanPrompt(prompt: string, origin: PromptOrigin = "api"): boolean {
	if (origin === "user") return true;
	for (const { pattern } of INJECTION_PATTERNS) {
		if (pattern.test(prompt)) return guardPrompt(prompt).findings.length === 0;
	}
	return true;
}
