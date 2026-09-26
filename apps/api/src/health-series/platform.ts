import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { bucketInterval, type SeriesWindow } from "./range.js";

function numberOrNull(value: number | string | null): number | null {
	return value === null ? null : Number(value);
}

/**
 * Availability, running count, CPU %, network and disk per bucket from the
 * worker's `health_samples` (docs/EPIC-19.md rulings 4, 14 to 17). Minutes
 * are counted once however many samples fall in them. The running count and
 * CPU % are the bucket's maximum; throughput is its average. Samples from
 * before Epic 19 have no rates or count, so those values are null.
 */
export async function platformSeries(
	db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["platform"]> {
	const result = await sql<{
		at: Date;
		sample_minutes: number;
		reachable_minutes: number;
		running: number | null;
		cpu: number | null;
		rx: number | null;
		tx: number | null;
		read: number | null;
		write: number | null;
	}>`
		select
			date_bin(${bucketInterval(window)}::interval, observed_at, ${window.from}) as at,
			count(distinct date_trunc('minute', observed_at))::int as sample_minutes,
			(count(distinct date_trunc('minute', observed_at))
				filter (where (sample->'controller'->>'reachable')::boolean))::int
				as reachable_minutes,
			max((sample->>'runningWorkspaces')::float8) as running,
			max((sample->'host'->'rates'->>'cpuPercent')::float8) as cpu,
			avg((sample->'host'->'rates'->>'netRxBytesPerSecond')::float8) as rx,
			avg((sample->'host'->'rates'->>'netTxBytesPerSecond')::float8) as tx,
			avg((sample->'host'->'rates'->>'diskReadBytesPerSecond')::float8) as read,
			avg((sample->'host'->'rates'->>'diskWriteBytesPerSecond')::float8) as write
		from health_samples
		where observed_at >= ${window.from} and observed_at < ${window.to}
		group by 1
		order by 1
	`.execute(db);
	return result.rows.map((row) => ({
		at: new Date(row.at).toISOString(),
		sampleMinutes: Number(row.sample_minutes),
		reachableMinutes: Number(row.reachable_minutes),
		runningWorkspaces: numberOrNull(row.running),
		cpuPercent: numberOrNull(row.cpu),
		netRxBytesPerSecond: numberOrNull(row.rx),
		netTxBytesPerSecond: numberOrNull(row.tx),
		diskReadBytesPerSecond: numberOrNull(row.read),
		diskWriteBytesPerSecond: numberOrNull(row.write),
	}));
}
