/**
 * What went wrong in sync runs, for the owner rather than the console: one
 * failed background sync (offline for a minute) is no news, three in a row
 * is. A rate limit is the cloud asking to slow down, not a failure — it
 * neither counts nor ends a streak.
 */

import { classifyFailure, type FailureKind } from "../transport/failure";

export interface RunFailure {
	/** The step that failed ("could not list the reMarkable account"). */
	what: string;
	message: string;
	kind: FailureKind;
}

export function runFailure(what: string, error: unknown): RunFailure {
	return { what, message: error instanceof Error ? error.message : String(error), kind: classifyFailure(error) };
}

/** Consecutive failed background syncs after which the owner is told. */
export const NOTICE_AFTER = 3;

export class FailureStreak {
	private streak = 0;
	/** The failures of the last run that failed, until a run succeeds. */
	last: RunFailure[] = [];

	/** Background syncs failed in a row so far. */
	get consecutive(): number {
		return this.streak;
	}

	/** Whether the last counted run failed: the status bar shows it until a run succeeds. */
	get failing(): boolean {
		return this.last.length > 0;
	}

	/**
	 * A run ended with these failures. Resolves to whether to show a notice
	 * now: when background runs reached NOTICE_AFTER failures in a row (once
	 * per streak). A manual run's failure is shown by the run itself.
	 */
	ended(failures: readonly RunFailure[], background: boolean): boolean {
		const counted = failures.filter((failure) => failure.kind !== "rate-limit");
		if (counted.length === 0) {
			if (failures.length === 0) {
				this.streak = 0;
				this.last = [];
			}
			return false;
		}
		this.last = counted;
		if (!background) return false;
		this.streak++;
		return this.streak === NOTICE_AFTER;
	}
}

/**
 * Sync runs one after another. A run that throws — or whose wrap-up does —
 * neither stops the runs queued after it nor rejects for its caller: the
 * error goes to `onError` (the console), and the queue moves on.
 */
export class RunQueue {
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly onError: (error: unknown) => void) {}

	/** Run `run` once the runs queued before it are done; resolves when it is, never rejects. */
	enqueue(run: () => Promise<void>): Promise<void> {
		const next = this.tail.then(run).catch((error: unknown) => {
			try {
				this.onError(error);
			} catch {
				// Reporting failed too: the queue still moves on.
			}
		});
		this.tail = next;
		return next;
	}
}
