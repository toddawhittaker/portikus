/**
 * How long an errored workspace that should run waits before the sweep
 * retries its start (SPEC.md §6.3). The count lives in
 * workspaces.start_retries, so a worker restart does not start it over.
 * After the last wait the sweep stops retrying until the student acts.
 */

const RETRY_WAITS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
export const MAX_START_RETRIES = RETRY_WAITS_MS.length;

/** The wait before retry number `retries + 1`, or null when retries ran out. */
export function retryWaitMs(retries: number): number | null {
	return RETRY_WAITS_MS[retries] ?? null;
}
