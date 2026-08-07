import { describe, expect, it } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../src/harness/messages.ts";
import type { AgentMessage } from "../../src/types.ts";

describe("messages utils", () => {
	it("formats bash execution with output", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "ls -la",
			output: "file1\nfile2",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(text).toContain("Ran `ls -la`");
		expect(text).toContain("file1\nfile2");
		expect(text).toContain("```");
	});

	it("formats bash execution with no output and non-zero exit code", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "false",
			output: "",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(text).toContain("(no output)");
		expect(text).toContain("Command exited with code 1");
	});

	it("formats cancelled bash execution", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "sleep 100",
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			timestamp: 1,
		});
		expect(text).toContain("(command cancelled)");
	});

	it("appends truncated output path", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "big",
			output: "x",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: "/tmp/full.txt",
			timestamp: 1,
		});
		expect(text).toContain("[Output truncated. Full output: /tmp/full.txt]");
	});

	it("creates branch and compaction summary messages with timestamps", () => {
		const branch = createBranchSummaryMessage("branch summary text", "msg-1", "2026-01-01T00:00:00.000Z");
		expect(branch.role).toBe("branchSummary");
		expect(branch.summary).toBe("branch summary text");
		expect(branch.fromId).toBe("msg-1");
		expect(branch.timestamp).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());

		const comp = createCompactionSummaryMessage("compacted", 5000, "2026-01-02T00:00:00.000Z");
		expect(comp.role).toBe("compactionSummary");
		expect(comp.tokensBefore).toBe(5000);
		expect(comp.timestamp).toBe(new Date("2026-01-02T00:00:00.000Z").getTime());
	});

	it("creates custom messages (string and content array)", () => {
		const str = createCustomMessage("note", "plain text", true, undefined, "2026-01-01T00:00:00.000Z");
		expect(str.role).toBe("custom");
		expect(str.customType).toBe("note");
		expect(str.content).toBe("plain text");
		expect(str.display).toBe(true);

		const arr = createCustomMessage(
			"img",
			[{ type: "text", text: "caption" }],
			false,
			{ meta: 1 },
			"2026-01-01T00:00:00.000Z",
		);
		expect(Array.isArray(arr.content)).toBe(true);
		expect(arr.details).toEqual({ meta: 1 });
		expect(arr.display).toBe(false);
	});

	it("convertToLlm converts bashExecution to user text messages", () => {
		const msgs: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo hi",
				output: "hi",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		];
		const llm = convertToLlm(msgs);
		expect(llm).toHaveLength(1);
		expect(llm[0].role).toBe("user");
		expect(llm[0].content).toEqual([{ type: "text", text: expect.stringContaining("echo hi") }]);
	});

	it("drops bashExecution when excludeFromContext is set", () => {
		const msgs: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "secret",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 1,
			},
		];
		expect(convertToLlm(msgs)).toHaveLength(0);
	});

	it("convertToLlm wraps branchSummary and compactionSummary with prefixes/suffixes", () => {
		const msgs: AgentMessage[] = [
			{ role: "branchSummary", summary: "b", fromId: "1", timestamp: 1 },
			{ role: "compactionSummary", summary: "c", tokensBefore: 10, timestamp: 2 },
		];
		const llm = convertToLlm(msgs);
		expect(llm).toHaveLength(2);
		expect(llm[0].content).toEqual([{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}b</summary>` }]);
		expect(llm[1].content).toEqual([
			{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}c${COMPACTION_SUMMARY_SUFFIX}` },
		]);
	});

	it("convertToLlm passes through user/assistant/toolResult and drops unknown roles", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text" as const, text: "hello" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text" as const, text: "hi" }], timestamp: 2 },
			{ role: "toolResult", content: [{ type: "text" as const, text: "done" }], timestamp: 3 },
			{ role: "custom", customType: "x", content: "s", display: true, timestamp: 4 },
			{ role: "unknownRole" as never, timestamp: 5 },
		];
		const llm = convertToLlm(msgs as AgentMessage[]);
		expect(llm).toHaveLength(4);
		expect(llm[3].content).toEqual([{ type: "text", text: "s" }]);
	});
});
