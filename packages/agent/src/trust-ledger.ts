/**
 * Supervisor/Coder trust scoring.
 *
 * The user's spec: when a coder is wrong, deduct 100 trust; when right, add 1.
 * The same rule applies to the supervisor. The score pool is 0-100 and the
 * ledger is brutally honest — every adjustment is recorded with a reason and
 * timestamps so nothing is hidden.
 */

export type AgentRole = "supervisor" | "coder";

export type Verdict = "correct" | "wrong";

export interface TrustAdjustment {
	role: AgentRole;
	delta: number;
	verdict: Verdict;
	reason: string;
	timestamp: number;
	/** Running score after this adjustment (per role). */
	scoreAfter: number;
}

export interface TrustState {
	supervisor: number;
	coder: number;
	adjustments: TrustAdjustment[];
}

const START_SCORE = 100;
const CORRECT_DELTA = 1;
const WRONG_DELTA = -100;

export class TrustLedger {
	private state: TrustState;

	constructor(startScore = START_SCORE) {
		this.state = {
			supervisor: startScore,
			coder: startScore,
			adjustments: [],
		};
	}

	/** Record a verdict for a role. Returns the adjustment entry. */
	record(role: AgentRole, verdict: Verdict, reason: string): TrustAdjustment {
		const delta = verdict === "correct" ? CORRECT_DELTA : WRONG_DELTA;
		const next = this.clamp(this.score(role) + delta);
		const entry: TrustAdjustment = {
			role,
			delta,
			verdict,
			reason,
			timestamp: Date.now(),
			scoreAfter: next,
		};
		if (role === "supervisor") this.state.supervisor = next;
		else this.state.coder = next;
		this.state.adjustments.push(entry);
		return entry;
	}

	score(role: AgentRole): number {
		return role === "supervisor" ? this.state.supervisor : this.state.coder;
	}

	/** Brutely honest report: every adjustment, newest last. */
	report(): TrustState {
		return {
			supervisor: this.state.supervisor,
			coder: this.state.coder,
			adjustments: [...this.state.adjustments],
		};
	}

	/** True when a role's score has bottomed out (0) — used to flag rewrites. */
	isDepleted(role: AgentRole): boolean {
		return this.score(role) <= 0;
	}

	/** Summary line for progress reports / Telegram. */
	summary(): string {
		return `supervisor=${this.state.supervisor} coder=${this.state.coder} adjustments=${this.state.adjustments.length}`;
	}

	private clamp(value: number): number {
		return Math.max(0, Math.min(100, value));
	}
}
