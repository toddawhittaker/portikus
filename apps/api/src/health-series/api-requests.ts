import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { API_LATENCY_BOUNDS_MS } from "../request-metrics.js";
import { bucketInterval, type SeriesWindow } from "./range.js";

/**
 * The response time below which `fraction` of the counted requests fall,
 * interpolated linearly inside the bucket that holds it. The overflow bucket
 * has no upper bound, so it reports its lower bound. Null when empty
 * (docs/EPIC-19.md ruling 22).
 */
export function latencyPercentile(
	buckets: readonly number[],
	fraction: number,
): number | null {
	const total = buckets.reduce((sum, count) => sum + count, 0);
	if (total === 0) return null;
	const target = fraction * total;
	let below = 0;
	for (let index = 0; index < buckets.length; index += 1) {
		const count = buckets[index] ?? 0;
		if (count > 0 && below + count >= target) {
			const lower = index === 0 ? 0 : (API_LATENCY_BOUNDS_MS[index - 1] ?? 0);
			const upper = API_LATENCY_BOUNDS_MS[index];
			if (upper === undefined) return lower;
			return lower + ((target - below) / count) * (upper - lower);
		}
		below += count;
	}
	return null;
}

/** Request counts, error counts and latency per bucket, from `api_request_samples`. */
export async function apiRequestSeries(
	db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["api"]> {
	const result = await sql<{
		at: Date;
		requests: number;
		client_errors: number;
		server_errors: number;
		websocket_upgrades: number;
		latency: number[] | null;
	}>`
		with binned as (
			select date_bin(${bucketInterval(window)}::interval, minute, ${window.from}) as at, *
			from api_request_samples
			where minute >= ${window.from} and minute < ${window.to}
		)
		select
			b.at,
			sum(b.requests)::int as requests,
			sum(b.client_errors)::int as client_errors,
			sum(b.server_errors)::int as server_errors,
			sum(b.websocket_upgrades)::int as websocket_upgrades,
			(
				select array_agg(total order by i)
				from (
					select u.i, sum(u.v)::int as total
					from binned b2, unnest(b2.latency_buckets) with ordinality as u(v, i)
					where b2.at = b.at
					group by u.i
				) sums
			) as latency
		from binned b
		group by b.at
		order by b.at
	`.execute(db);
	return result.rows.map((row) => {
		const latency = row.latency ?? [];
		return {
			at: new Date(row.at).toISOString(),
			requests: row.requests,
			clientErrors: row.client_errors,
			serverErrors: row.server_errors,
			webSocketUpgrades: row.websocket_upgrades,
			medianMs: latencyPercentile(latency, 0.5),
			p95Ms: latencyPercentile(latency, 0.95),
		};
	});
}
