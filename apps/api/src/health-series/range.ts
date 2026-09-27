import {
	HEALTH_BUCKET_SECONDS,
	HEALTH_RANGE_SECONDS,
	type HealthRange,
} from "@portikus/contracts";

/**
 * The time window one series request covers. `to` is the end of the bucket
 * that holds `now`, so the newest bucket is the current, partial one, and
 * `from` is exactly the range before it. Each family module selects rows in
 * `[from, to)` and bins them with `date_bin(bucket, at, from)`.
 */
export interface SeriesWindow {
	range: HealthRange;
	bucketSeconds: number;
	from: Date;
	to: Date;
}

export function seriesWindow(range: HealthRange, now: Date): SeriesWindow {
	const bucketSeconds = HEALTH_BUCKET_SECONDS[range];
	const bucketMs = bucketSeconds * 1000;
	const to = new Date((Math.floor(now.getTime() / bucketMs) + 1) * bucketMs);
	const from = new Date(to.getTime() - HEALTH_RANGE_SECONDS[range] * 1000);
	return { range, bucketSeconds, from, to };
}

/** The bucket width as a PostgreSQL interval literal, for `date_bin`. */
export function bucketInterval(window: SeriesWindow): string {
	return `${window.bucketSeconds} seconds`;
}
