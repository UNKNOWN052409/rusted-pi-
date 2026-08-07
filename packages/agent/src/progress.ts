/**
 * Progress telemetry — records % completion and what happened at each phase,
 * and pushes updates to pluggable sinks (console, Telegram, HTTP/webhook) so
 * progress is viewable from any computer or via Telegram.
 *
 * Sinks are best-effort: a failing sink never crashes the task loop.
 */

export interface ProgressEvent {
	/** 0-100 overall completion. */
	progress: number;
	/** Short human line, e.g. "phase=coding wrote 3 files". */
	message: string;
	phase: string;
	timestamp: number;
}

export interface ProgressSink {
	/** Called for each event; must never throw (wrapped by the tracker). */
	emit: (event: ProgressEvent) => Promise<void> | void;
}

export interface ProgressTrackerOptions {
	sinks?: ProgressSink[];
	/** Also print to console.log (default true). */
	consoleLog?: boolean;
}

export class ProgressTracker {
	private readonly sinks: ProgressSink[];
	private readonly consoleLog: boolean;
	private readonly events: ProgressEvent[] = [];

	constructor(options: ProgressTrackerOptions = {}) {
		this.sinks = [...(options.sinks ?? [])];
		this.consoleLog = options.consoleLog ?? true;
	}

	/** Record progress; clamps 0-100, never throws. */
	report(progress: number, message: string, phase = "working"): ProgressEvent {
		const clamped = Math.max(0, Math.min(100, Math.round(progress)));
		const event: ProgressEvent = { progress: clamped, message, phase, timestamp: Date.now() };
		this.events.push(event);
		if (this.consoleLog) console.log(`[rust] ${clamped}% ${phase}: ${message}`);
		for (const sink of this.sinks) {
			try {
				const result = sink.emit(event);
				if (result && typeof (result as Promise<void>).catch === "function") {
					void (result as Promise<void>).catch(() => {});
				}
			} catch {
				// Sinks are best-effort; never let one break the loop.
			}
		}
		return event;
	}

	/** History of all reported events, oldest first. */
	history(): ProgressEvent[] {
		return [...this.events];
	}

	/** Latest reported progress (0 when none yet). */
	get latest(): number {
		return this.events.length > 0 ? this.events[this.events.length - 1]!.progress : 0;
	}

	/** Format a compact status line for Telegram/HTTP viewers. */
	statusLine(): string {
		if (this.events.length === 0) return "0% (not started)";
		const last = this.events[this.events.length - 1]!;
		return `${last.progress}% [${last.phase}] ${last.message}`;
	}
}

/** Sink that forwards events to a remote HTTP webhook (browser dashboard). */
export function httpSink(url: string, fetchImpl: typeof fetch = fetch): ProgressSink {
	return {
		emit: async (event) => {
			await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event),
			});
		},
	};
}

/** Sink that prints to stdout (useful in CI/headless). */
export function consoleSink(print: (line: string) => void = (l) => console.log(l)): ProgressSink {
	return {
		emit: (event) => {
			print(`[rust] ${event.progress}% ${event.phase}: ${event.message}`);
		},
	};
}
