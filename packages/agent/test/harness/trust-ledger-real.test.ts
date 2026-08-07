import { describe, expect, it } from "vitest";
import { TrustLedger } from "../../src/trust-ledger.ts";

describe("TrustLedger (supervisor/coder trust scoring)", () => {
	it("starts both roles at 100", () => {
		const ledger = new TrustLedger();
		expect(ledger.score("supervisor")).toBe(100);
		expect(ledger.score("coder")).toBe(100);
	});

	it("adds 1 for a correct verdict (clamped to pool cap 100)", () => {
		const ledger = new TrustLedger();
		const entry = ledger.record("coder", "correct", "mcp tool call returned expected result");
		expect(entry.delta).toBe(1);
		expect(entry.scoreAfter).toBe(100); // pool cap: 100+1 stays 100
		expect(ledger.score("coder")).toBe(100);
	});

	it("deducts 100 for a wrong verdict", () => {
		const ledger = new TrustLedger();
		const entry = ledger.record("coder", "wrong", "stubbed a real function instead of calling it");
		expect(entry.delta).toBe(-100);
		expect(entry.scoreAfter).toBe(0);
		expect(ledger.isDepleted("coder")).toBe(true);
	});

	it("tracks supervisor and coder independently", () => {
		const ledger = new TrustLedger();
		ledger.record("supervisor", "correct", "caught an empty branch");
		ledger.record("coder", "wrong", "introduced a hollow success path");
		expect(ledger.score("supervisor")).toBeGreaterThan(ledger.score("coder"));
	});

	it("records a brutally honest ledger with reasons and timestamps", () => {
		const ledger = new TrustLedger();
		ledger.record("supervisor", "wrong", "missed a stubbed branch");
		ledger.record("coder", "correct", "fixed the stubbed branch");
		const report = ledger.report();
		expect(report.adjustments.length).toBe(2);
		expect(report.adjustments[0]).toMatchObject({
			role: "supervisor",
			verdict: "wrong",
			reason: "missed a stubbed branch",
			delta: -100,
		});
		expect(typeof report.adjustments[0].timestamp).toBe("number");
		expect(report.adjustments[1].scoreAfter).toBe(ledger.score("coder"));
		expect(ledger.summary()).toContain("supervisor=0");
		expect(ledger.summary()).toContain("coder=100"); // +1 from 0, clamped at 100
	});

	it("clamps scores to the 0-100 pool", () => {
		const ledger = new TrustLedger();
		for (let i = 0; i < 10; i++) ledger.record("coder", "correct", "streak");
		expect(ledger.score("coder")).toBe(100);
		for (let i = 0; i < 3; i++) ledger.record("coder", "wrong", "catastrophic");
		expect(ledger.score("coder")).toBe(0);
	});
});
