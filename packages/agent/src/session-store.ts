/**
 * Resumable sessions — every session gets a token (`rusted pi -resume <token>`)
 * so work can be picked up later from the exact working directory and phase.
 *
 * State is persisted as JSON files under a session dir (~/.rusted-pi/sessions).
 * Tokens are random, collision-resistant, and never expire by default.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionState {
	token: string;
	createdAt: number;
	updatedAt: number;
	/** Working directory to resume from after compaction. */
	cwd: string;
	/** Human description of the task. */
	task: string;
	/** Current phase (e.g. "reading", "coding", "verifying"). */
	phase: string;
	/** 0-100 completion estimate. */
	progress: number;
	/** Optional notes (last summary, checkpoint text). */
	notes?: string;
}

export interface SessionStoreOptions {
	/** Override the session dir (tests). */
	dir?: string;
}

const DEFAULT_DIR = join(homedir(), ".rusted-pi", "sessions");

export class SessionStore {
	private readonly dir: string;

	constructor(options: SessionStoreOptions = {}) {
		this.dir = options.dir ?? DEFAULT_DIR;
		mkdirSync(this.dir, { recursive: true });
	}

	/** Create a new session and return its state + token. */
	create(input: { cwd: string; task: string; phase?: string }): SessionState {
		const token = randomBytes(8).toString("hex");
		const state: SessionState = {
			token,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: input.cwd,
			task: input.task,
			phase: input.phase ?? "starting",
			progress: 0,
		};
		this.save(state);
		return state;
	}

	/** Load a session by token; throws when unknown. */
	load(token: string): SessionState {
		const file = this.fileFor(token);
		if (!existsSync(file)) throw new Error(`No session found for token "${token}"`);
		return JSON.parse(readFileSync(file, "utf8")) as SessionState;
	}

	/** Update a session (progress, phase, notes) and bump updatedAt. */
	update(
		token: string,
		patch: Partial<Pick<SessionState, "cwd" | "phase" | "progress" | "notes" | "task">>,
	): SessionState {
		const state = this.load(token);
		const next: SessionState = {
			...state,
			...patch,
			updatedAt: Date.now(),
		};
		this.save(next);
		return next;
	}

	/** List all sessions, newest first. */
	list(): SessionState[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionState;
				} catch {
					return null;
				}
			})
			.filter((s): s is SessionState => s !== null)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt);
	}

	private fileFor(token: string): string {
		return join(this.dir, `${token}.json`);
	}

	private save(state: SessionState): void {
		writeFileSync(this.fileFor(state.token), JSON.stringify(state, null, 2), "utf8");
	}
}
