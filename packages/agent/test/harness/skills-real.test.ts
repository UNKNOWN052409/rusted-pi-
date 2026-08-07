import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { formatSkillInvocation, loadSkills, loadSourcedSkills } from "../../src/harness/skills.ts";
import type { Skill } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

async function createEnv() {
	return new NodeExecutionEnv({ cwd: createTempDir() });
}

function writeSkillFiles(env: NodeExecutionEnv, base: string, files: Array<{ path: string; content: string }>) {
	return Promise.all(files.map((f) => env.writeFile(`${base}/${f.path}`, f.content)));
}

describe("loadSkills (real files)", () => {
	it("loads a SKILL.md from a subdirectory with frontmatter", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "my-skill/SKILL.md",
				content: "---\nname: my-skill\ndescription: Does the thing\n---\nStep 1: do it\n",
			},
		]);
		const { skills, diagnostics } = await loadSkills(env, base);
		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("my-skill");
		expect(skills[0].description).toBe("Does the thing");
		expect(skills[0].content).toContain("Step 1: do it");
		expect(skills[0].disableModelInvocation).toBe(false);
		expect(diagnostics).toHaveLength(0);
	});

	it("loads root-level .md files as skills", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "root-doc.md",
				content: "---\nname: root-doc\ndescription: Root doc skill\n---\nBody here\n",
			},
		]);
		const { skills } = await loadSkills(env, base);
		expect(skills.some((s) => s.name === "root-doc")).toBe(true);
	});

	it("honors .gitignore patterns (ignored skills are not loaded)", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{ path: ".gitignore", content: "secret-skill/\n" },
			{
				path: "secret-skill/SKILL.md",
				content: "---\nname: secret-skill\ndescription: Should be ignored\n---\nbody\n",
			},
			{
				path: "public-skill/SKILL.md",
				content: "---\nname: public-skill\ndescription: Kept\n---\nbody\n",
			},
		]);
		const { skills } = await loadSkills(env, base);
		expect(skills.some((s) => s.name === "secret-skill")).toBe(false);
		expect(skills.some((s) => s.name === "public-skill")).toBe(true);
	});

	it("skips missing directories silently", async () => {
		const env = await createEnv();
		const { skills, diagnostics } = await loadSkills(env, "does-not-exist");
		expect(skills).toHaveLength(0);
		expect(diagnostics).toHaveLength(0);
	});

	it("emits parse_failed diagnostic for malformed YAML", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "broken/SKILL.md",
				content: "---\nname: [unclosed\ndescription: x\n---\nbody\n",
			},
		]);
		const { skills, diagnostics } = await loadSkills(env, base);
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.code === "parse_failed")).toBe(true);
	});

	it("emits invalid_metadata diagnostic for name mismatch and empty description", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "dir-a/SKILL.md",
				content: "---\nname: different-name\ndescription: Valid desc\n---\nbody\n",
			},
			{
				path: "dir-b/SKILL.md",
				content: '---\nname: dir-b\ndescription: ""\n---\nbody\n',
			},
		]);
		const { skills, diagnostics } = await loadSkills(env, base);
		expect(skills).toHaveLength(1); // only dir-a loads; dir-b empty desc -> dropped
		expect(diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("does not match"))).toBe(true);
		expect(
			diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("description is required")),
		).toBe(true);
	});

	it("loads from multiple directories", async () => {
		const env = await createEnv();
		await writeSkillFiles(env, "a", [
			{ path: "s1/SKILL.md", content: "---\nname: s1\ndescription: one\n---\nbody\n" },
		]);
		await writeSkillFiles(env, "b", [
			{ path: "s2/SKILL.md", content: "---\nname: s2\ndescription: two\n---\nbody\n" },
		]);
		const { skills } = await loadSkills(env, ["a", "b"]);
		expect(skills.map((s) => s.name).sort()).toEqual(["s1", "s2"]);
	});

	it("honors disable-model-invocation flag", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "hidden/SKILL.md",
				content: '---\nname: hidden\ndescription: hidden skill\n"disable-model-invocation": true\n---\nbody\n',
			},
		]);
		const { skills } = await loadSkills(env, base);
		expect(skills[0].disableModelInvocation).toBe(true);
	});

	it("loadSourcedSkills attaches source provenance", async () => {
		const env = await createEnv();
		await writeSkillFiles(env, "src1", [
			{ path: "s/SKILL.md", content: "---\nname: s\ndescription: from src1\n---\nbody\n" },
		]);
		const { skills, diagnostics } = await loadSourcedSkills(
			env,
			[{ path: "src1", source: { repo: "repo-a" } }],
			(skill, source) => ({ ...skill, name: `${skill.name}@${source.repo}` }),
		);
		expect(skills[0].skill.name).toBe("s@repo-a");
		expect(skills[0].source).toEqual({ repo: "repo-a" });
		expect(diagnostics).toHaveLength(0);
	});

	it("formatSkillInvocation renders the skill block", () => {
		const skill: Skill = {
			name: "test-skill",
			description: "d",
			content: "instructions here",
			filePath: "/skills/test-skill/SKILL.md",
		};
		const formatted = formatSkillInvocation(skill);
		expect(formatted).toContain('<skill name="test-skill"');
		expect(formatted).toContain("instructions here");
		expect(formatted).not.toContain("extra");
		const withExtra = formatSkillInvocation(skill, "Extra instructions");
		expect(withExtra).toContain("Extra instructions");
	});
});

describe("loadSkills nested + edge cases (real files)", () => {
	it("loads nested subdirectories recursively", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "outer/inner/deep/SKILL.md",
				content: "---\nname: deep\ndescription: nested skill\n---\nbody\n",
			},
		]);
		const { skills } = await loadSkills(env, base);
		expect(skills.some((s) => s.name === "deep")).toBe(true);
	});

	it("skips node_modules and dot directories", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [
			{
				path: "node_modules/pkg/SKILL.md",
				content: "---\nname: pkg\ndescription: should skip\n---\nbody\n",
			},
			{
				path: ".hidden/SKILL.md",
				content: "---\nname: hidden\ndescription: should skip\n---\nbody\n",
			},
			{
				path: "real/SKILL.md",
				content: "---\nname: real\ndescription: kept\n---\nbody\n",
			},
		]);
		const { skills } = await loadSkills(env, base);
		expect(skills.map((s) => s.name)).toEqual(["real"]);
	});

	it("treats files without frontmatter as plain body (no name validation)", async () => {
		const env = await createEnv();
		const base = "skills";
		await writeSkillFiles(env, base, [{ path: "plain/SKILL.md", content: "no frontmatter here\n" }]);
		const { skills } = await loadSkills(env, base);
		// no description -> skill dropped, but a diagnostic about description is not required
		expect(skills).toHaveLength(0);
	});
});
