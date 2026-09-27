import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { API_LATENCY_BOUNDS_MS } from "../request-metrics.js";
import { bucketInterval, type SeriesWindow } from "./range.js";

/**
 * The response time below which `fraction` of the counted requests fall,
 * interpolated linearly inside the bucket that holds it. The overflow bucket
 * has no upper bound, so it reports its lower bound. Null when empty
 * (SPEC.md section 25.6).
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
		latency_buckets: number[];
	}>`
		select
			date_bin(${bucketInterval(window)}::interval, minute, ${window.from}) as at,
			requests, client_errors, server_errors, websocket_upgrades, latency_buckets
		from api_request_samples
		where minute >= ${window.from} and minute < ${window.to}
		order by minute
	`.execute(db);

	type Bucket = HealthSeries["api"][number] & { latency: number[] };
	const buckets = new Map<string, Bucket>();
	for (const row of result.rows) {
		const at = new Date(row.at).toISOString();
		let bucket = buckets.get(at);
		if (!bucket) {
			bucket = {
				at,
				requests: 0,
				clientErrors: 0,
				serverErrors: 0,
				webSocketUpgrades: 0,
				medianMs: null,
				p95Ms: null,
				latency: [],
			};
			buckets.set(at, bucket);
		}
		bucket.requests += row.requests;
		bucket.clientErrors += row.client_errors;
		bucket.serverErrors += row.server_errors;
		bucket.webSocketUpgrades += row.websocket_upgrades;
		row.latency_buckets.forEach((count, index) => {
			bucket.latency[index] = (bucket.latency[index] ?? 0) + count;
		});
	}
	return [...buckets.values()].map(({ latency, ...bucket }) => ({
		...bucket,
		medianMs: latencyPercentile(latency, 0.5),
		p95Ms: latencyPercentile(latency, 0.95),
	}));
}
