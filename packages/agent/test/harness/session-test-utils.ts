import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach } from "vitest";

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const tempDirs: string[] = [];

/**
 * Probe whether symlinks can be created on this host. Windows hosts without
 * Developer Mode throw EPERM on symlink creation; tests that need real symlinks
 * skip (honest-degrade) when this returns false so they still run on Linux/CI.
 * The result is cached after the first call.
 */
export function canCreateSymlink(): boolean {
	if (canCreateSymlinkCached !== undefined) {
		return canCreateSymlinkCached;
	}
	try {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		writeFileSync(target, "x");
		symlinkSync(target, join(dir, "link.txt"));
		canCreateSymlinkCached = true;
	} catch {
		canCreateSymlinkCached = false;
	}
	return canCreateSymlinkCached;
}

let canCreateSymlinkCached: boolean | undefined;

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

export function getLatestTempDir(): string {
	return tempDirs[tempDirs.length - 1]!;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
