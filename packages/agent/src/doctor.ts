/**
 * Doctor / self-healing agent — diagnoses flaws in the local repo and (when
 * trusted and not in dry-run) applies fixes, scoring them with the trust
 * ledger so the system gets "brutally honest" about its own fixes. Runs as a
 * periodic scan and can be invoked when idle to hunt for flaws.
 *
 * Healing is gated: a dry-run flag means the doctor only reports, never edits.
 * Real auto-fix is only applied when the trust gate passes.
 */

import { TrustLedger } from "./trust-ledger.ts";

export interface DoctorCheck {
	name: string;
	/** Return true when a flaw is present. */
	run: () => Promise<boolean>;
	/** Optional: actually fix the flaw. Returns true on success. */
	fix?: () => Promise<boolean>;
	/** Human description of the check. */
	describe?: string;
}

export interface DoctorOptions {
	/** If true, never edit files — only report. */
	dryRun?: boolean;
	/** Minimum coder trust score required to auto-apply a fix. */
	trustGate?: number;
	/** Optional trust ledger (injectable for tests). */
	trust?: TrustLedger;
	/** Callback for each diagnostic outcome. */
	onDiagnosis?: (d: DiagnosisResult) => void;
}

export interface DiagnosisResult {
	check: string;
	flawed: boolean;
	status: "ok" | "flaw" | "fixed" | "skipped-dry" | "fix-failed";
	message: string;
}

export interface DoctorRunResult {
	diagnoses: DiagnosisResult[];
	fixed: number;
}

export class Doctor {
	private readonly dryRun: boolean;
	private readonly trustGate: number;
	private readonly ledger: TrustLedger;
	private readonly onDiagnosis: ((d: DiagnosisResult) => void) | undefined;

	constructor(options: DoctorOptions = {}) {
		this.dryRun = options.dryRun ?? false;
		this.trustGate = options.trustGate ?? 50;
		this.ledger = options.trust ?? new TrustLedger();
		this.onDiagnosis = options.onDiagnosis;
	}

	/** Run all checks; attempt fixes for flawed ones when allowed. */
	async runAll(checks: DoctorCheck[]): Promise<DoctorRunResult> {
		const diagnoses: DiagnosisResult[] = [];
		let fixed = 0;
		for (const check of checks) {
			const flawed = await check.run().catch(() => false);
			let diagnosis: DiagnosisResult = {
				check: check.name,
				flawed: false,
				status: "ok",
				message: check.describe ?? check.name,
			};
			if (flawed) {
				if (this.dryRun || this.ledger.score("coder") < this.trustGate) {
					diagnosis = {
						check: check.name,
						flawed: true,
						status: this.dryRun ? "skipped-dry" : "flaw",
						message: `${check.describe ?? check.name}: ${this.dryRun ? "dry-run, fix not applied" : "trust below gate"}`,
					};
				} else if (check.fix) {
					const okFix = await check.fix().catch(() => false);
					if (okFix) {
						fixed += 1;
						this.ledger.record("coder", "correct", `doctor fixed ${check.name}`);
						diagnosis = {
							check: check.name,
							flawed: true,
							status: "fixed",
							message: `${check.describe ?? check.name}: fixed`,
						};
					} else {
						this.ledger.record("coder", "wrong", `doctor failed to fix ${check.name}`);
						diagnosis = {
							check: check.name,
							flawed: true,
							status: "fix-failed",
							message: `${check.describe ?? check.name}: fix failed`,
						};
					}
				} else {
					diagnosis = {
						check: check.name,
						flawed: true,
						status: "flaw",
						message: `${check.describe ?? check.name}: no fix attached`,
					};
				}
			}
			diagnoses.push(diagnosis);
			this.onDiagnosis?.(diagnosis);
		}
		return { diagnoses, fixed };
	}

	/** Short summary line useful for progress reports. */
	summary(result: DoctorRunResult): string {
		const flawed = result.diagnoses.filter((d) => d.flawed).length;
		return `doctor: ${result.fixed} fixed, ${flawed} flawed, ${result.diagnoses.length - flawed} ok`;
	}
}
