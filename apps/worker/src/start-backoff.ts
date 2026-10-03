/**
 * How long an errored workspace that should run waits before the sweep
 * retries its start (SPEC.md §6.3). The wait doubles with each retry, from
 * 10 seconds up to 30 minutes, so a workspace whose start always fails is
 * not force-stopped and booted again every few seconds. It is kept in
 * memory only: a worker restart starts every workspace over at 10 seconds.
 */

const FIRST_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 30 * 60_000;

interface Backoff {
	retries: number;
	desiredState: string;
}

const backoffs = new Map<string, Backoff>();

/** The wait before retry number `retries + 1`. */
export function retryWaitMs(retries: number): number {
	return Math.min(FIRST_WAIT_MS * 2 ** retries, MAX_WAIT_MS);
}

/**
 * Whether a workspace that went into error at `erroredAt` is due a retry.
 * A change of desired state since the last retry starts the wait over.
 */
export function retryDue(
	id: string,
	desiredState: string,
	erroredAt: Date,
	now: Date,
): boolean {
	const backoff = backoffs.get(id);
	if (backoff && backoff.desiredState !== desiredState) backoffs.delete(id);
	const retries = backoffs.get(id)?.retries ?? 0;
	return now.getTime() - erroredAt.getTime() >= retryWaitMs(retries);
}

/** Count a retry; returns which attempt this is, from 1. */
export function noteRetry(id: string, desiredState: string): number {
	const retries = (backoffs.get(id)?.retries ?? 0) + 1;
	backoffs.set(id, { retries, desiredState });
	return retries;
}

/** Start the wait over, as when the workspace reaches running. */
export function clearRetries(id: string): void {
	backoffs.delete(id);
}
