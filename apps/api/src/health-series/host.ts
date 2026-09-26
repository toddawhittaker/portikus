import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { bucketInterval, type SeriesWindow } from "./range.js";

/**
 * Pool and memory percentages and the three load averages, the maximum in
 * each bucket, from the worker's `health_samples` (docs/EPIC-19.md ruling 4).
 * Samples taken while the controller was unreachable have no host and are
 * left out, so their buckets are gaps.
 */
export async function hostSeries(
	db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["host"]> {
	const result = await sql<{
		at: Date;
		pool_percent: number;
		memory_percent: number;
		load1: number;
		load5: number;
		load15: number;
	}>`
		select
			date_bin(${bucketInterval(window)}::interval, observed_at, ${window.from}) as at,
			max(100.0 * (sample->'host'->'pool'->>'usedBytes')::float8
				/ nullif((sample->'host'->'pool'->>'totalBytes')::float8, 0)) as pool_percent,
			max(100.0 * (sample->'host'->'memory'->>'usedBytes')::float8
				/ nullif((sample->'host'->'memory'->>'totalBytes')::float8, 0)) as memory_percent,
			max((sample->'host'->'loadAverage'->>0)::float8) as load1,
			max((sample->'host'->'loadAverage'->>1)::float8) as load5,
			max((sample->'host'->'loadAverage'->>2)::float8) as load15
		from health_samples
		where observed_at >= ${window.from} and observed_at < ${window.to}
			and jsonb_typeof(sample->'host') = 'object'
		group by 1
		order by 1
	`.execute(db);
	return result.rows.map((row) => ({
		at: new Date(row.at).toISOString(),
		poolPercent: Number(row.pool_percent ?? 0),
		memoryPercent: Number(row.memory_percent ?? 0),
		load1: Number(row.load1),
		load5: Number(row.load5),
		load15: Number(row.load15),
	}));
}

/** The CPU count in the newest sample that has host figures, or null. */
export async function newestCpuCount(db: Kysely<Database>): Promise<number | null> {
	const row = await sql<{ cpu_count: number | null }>`
		select (sample->'host'->>'cpuCount')::int as cpu_count
		from health_samples
		where jsonb_typeof(sample->'host') = 'object'
		order by observed_at desc
		limit 1
	`.execute(db);
	return row.rows[0]?.cpu_count ?? null;
}
