/** The times a root job's status carries; the image, certificate and alerts jobs share them. */
export type JobTimes = {
	state: string;
	requestedAt: string | null;
	startedAt: string | null;
};

/**
 * When an unfinished job counts as dead: `staleMs` after it started
 * running, or else after it was queued. Null for a finished job; NaN when
 * the time is unknown, which never goes stale.
 */
export function jobStaleAt(
	job: JobTimes | null | undefined,
	staleMs: number,
): number | null {
	if (job?.state !== "queued" && job?.state !== "running") return null;
	const since = job.state === "running" ? job.startedAt : job.requestedAt;
	return since ? Date.parse(since) + staleMs : Number.NaN;
}

/** Queued or running, and not yet stale: a new request waits for it. */
export function isJobActive(
	job: JobTimes | null | undefined,
	staleMs: number,
	now: number = Date.now(),
): boolean {
	const at = jobStaleAt(job, staleMs);
	return at !== null && (Number.isNaN(at) || now < at);
}
