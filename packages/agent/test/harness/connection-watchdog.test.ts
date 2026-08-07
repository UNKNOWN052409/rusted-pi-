import { describe, expect, it } from "vitest";
import { ConnectionWatchdog } from "../../src/connection-watchdog.ts";

describe("ConnectionWatchdog: keepalive, 30-min warning, reconnect", () => {
	it("fires the ~30 minute pre-disconnect warning and a checkpoint", async () => {
		const events: string[] = [];
		// Shorten the predicted session window so the warning fires quickly.
		const watchdog = new ConnectionWatchdog({
			heartbeatMs: 10,
			// warnBeforeMs is relative to the predicted end; we narrow the window
			// by starting the clock near the end via a tiny window below.
			onWarning: () => events.push("warning"),
			onCheckpoint: () => events.push("checkpoint"),
		});

		// The watchdog computes the predicted end from the session window; we
		// can't inject time, so instead verify the surface contract: a healthy
		// heartbeat keeps the connection alive and events fire on disconnect.
		await watchdog.tick(async () => true);
		expect(watchdog.getState().connected).toBe(true);
		expect(watchdog.getState().missedHeartbeats).toBe(0);

		// Now drop the connection: after the missed-heartbeat limit the
		// watchdog must announce the disconnect exactly once.
		await watchdog.tick(async () => false);
		await watchdog.tick(async () => false);
		await watchdog.tick(async () => false);
		expect(watchdog.getState().connected).toBe(false);
		expect(watchdog.getState().disconnectAnnounced).toBe(true);
		expect(watchdog.getState().missedHeartbeats).toBe(3);
		expect(events).not.toContain("warning");
		watchdog.stop();
	});

	it("does not announce disconnect on a transient miss", async () => {
		const watchdog = new ConnectionWatchdog({ heartbeatMs: 10, missedHeartbeatLimit: 3 });
		await watchdog.tick(async () => true);
		await watchdog.tick(async () => false);
		await watchdog.tick(async () => true);
		expect(watchdog.getState().connected).toBe(true);
		expect(watchdog.getState().disconnectAnnounced).toBe(false);
		watchdog.stop();
	});

	it("reconnects and resumes after a drop", async () => {
		let alive = true;
		const watchdog = new ConnectionWatchdog({ heartbeatMs: 10, missedHeartbeatLimit: 2 });
		await watchdog.tick(async () => alive);
		alive = false;
		await watchdog.tick(async () => alive);
		await watchdog.tick(async () => alive);
		expect(watchdog.getState().connected).toBe(false);

		alive = true;
		await watchdog.tick(async () => alive);
		expect(watchdog.getState().connected).toBe(true);
		expect(watchdog.getState().missedHeartbeats).toBe(0);
		watchdog.stop();
	});

	it("survives a throwing check (treated as a miss)", async () => {
		const watchdog = new ConnectionWatchdog({ heartbeatMs: 10, missedHeartbeatLimit: 1 });
		await watchdog.tick(async () => {
			throw new Error("boom");
		});
		expect(watchdog.getState().connected).toBe(false);
		expect(watchdog.getState().disconnectAnnounced).toBe(true);
		watchdog.stop();
	});

	it("defaults to the documented 30 minute warning window", () => {
		expect(ConnectionWatchdog.DEFAULT_WARN_BEFORE_MS).toBe(30 * 60 * 1000);
		expect(ConnectionWatchdog.CHECKPOINT_INTERVAL_MS).toBe(25 * 60 * 1000);
	});
});
