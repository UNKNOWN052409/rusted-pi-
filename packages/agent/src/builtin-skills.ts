import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Built-in skills shipped with the rusted-pi harness.
 *
 * These live in `packages/agent/skills/` as standard SKILL.md files (the same
 * format `loadSkills` understands), so users can add their own skills next to
 * them and the whole directory loads uniformly.
 */
export const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Names of the skills that ship by default. */
export const BUILTIN_SKILL_NAMES = [
	"brainstorming",
	"council",
	"doctor-check",
	"qa-tester",
	"youtube-ui-reverse",
] as const;

/** Returns the absolute path to a built-in skill directory. */
export function builtinSkillPath(name: string): string {
	return join(BUILTIN_SKILLS_DIR, name);
}
