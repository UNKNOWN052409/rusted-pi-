import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS_DIR } from "../../src/builtin-skills.ts";
import { type CouncilAdvisor, runCouncil } from "../../src/council.ts";

describe("builtin-skills", () => {
	it("exposes a real skills directory", () => {
		expect(existsSync(BUILTIN_SKILLS_DIR)).toBe(true);
	});

	it("ships the expected built-in skills as SKILL.md files", () => {
		for (const name of ["brainstorming", "council", "doctor-check", "qa-tester"]) {
			const skillFile = join(BUILTIN_SKILLS_DIR, name, "SKILL.md");
			expect(existsSync(skillFile), `${name} SKILL.md missing`).toBe(true);
		}
	});
});

describe("council", () => {
	const panel: CouncilAdvisor[] = [
		{
			name: "alice",
			persona: "Optimist",
			opine: () => ({ title: "Yes", reasoning: "Looks great.", stance: "agree", confidence: 8 }),
		},
		{
			name: "bob",
			persona: "Pessimist",
			opine: () => ({ title: "No", reasoning: "Too risky.", stance: "disagree", confidence: 7 }),
		},
	];

	it("collects independent opinions from every advisor", async () => {
		const { opinions, verdict } = await runCouncil("Should we ship?", { advisors: panel, peerReview: false });
		expect(opinions).toHaveLength(2);
		expect(opinions.map((o) => o.advisor).sort()).toEqual(["alice", "bob"]);
		expect(verdict.advisors).toBe(2);
	});

	it("runs parallel by default", async () => {
		let active = 0;
		let maxActive = 0;
		const slow: CouncilAdvisor[] = [
			{
				name: "a",
				persona: "x",
				opine: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 20));
					active--;
					return { title: "a", reasoning: "r", stance: "agree" as const, confidence: 5 };
				},
			},
			{
				name: "b",
				persona: "x",
				opine: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 20));
					active--;
					return { title: "b", reasoning: "r", stance: "agree" as const, confidence: 5 };
				},
			},
		];
		await runCouncil("q", { advisors: slow, peerReview: false });
		expect(maxActive).toBeGreaterThan(1);
	});

	it("performs anonymous peer review when enabled", async () => {
		const { reviews, verdict } = await runCouncil("q", { advisors: panel, peerReview: true });
		expect(reviews.length).toBeGreaterThan(0);
		expect(reviews.every((r) => r.reviewer !== r.target)).toBe(true);
		expect(verdict.avgReviewScore).toBeGreaterThan(0);
	});

	it("synthesizes a verdict with confidence and top concern", async () => {
		const { verdict } = await runCouncil("q", { advisors: panel, peerReview: true });
		expect(verdict.summary).toContain("1/2");
		expect(verdict.confidence).toBeGreaterThan(0);
		expect(verdict.confidence).toBeLessThanOrEqual(10);
		expect(verdict.topConcern).toBeTruthy();
	});
});
