import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { bucketInterval, type SeriesWindow } from "./range.js";

/** Every action the two event charts count (docs/EPIC-19.md ruling 19). */
const ACTIONS = [
	"workspace.cpu_throttled",
	"workspace.memory_flagged",
	"workspace.idle_stopped",
	"workspace.cpu_throttle_lifted",
	"workspace.memory_flag_cleared",
	"workspace.start_requested",
	"workspace.stop_requested",
	"auth.login",
];

/**
 * Guard events and activity per bucket from `audit_events`. Requests, not
 * the worker's observations, count as starts and stops; an idle stop counts
 * as both a guard event and a stop; only successful sign-ins count. The
 * query names its actions so the `(action, at)` index is used.
 */
export async function eventSeries(
	db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["events"]> {
	const result = await sql<{
		at: Date;
		throttles: string;
		memory_flags: string;
		idle_stops: string;
		guard_lifts: string;
		starts: string;
		stops: string;
		sign_ins: string;
	}>`
		select
			date_bin(${bucketInterval(window)}::interval, at, ${window.from}) as at,
			count(*) filter (where action = 'workspace.cpu_throttled') as throttles,
			count(*) filter (where action = 'workspace.memory_flagged') as memory_flags,
			count(*) filter (where action = 'workspace.idle_stopped') as idle_stops,
			count(*) filter (where action in
				('workspace.cpu_throttle_lifted', 'workspace.memory_flag_cleared')) as guard_lifts,
			count(*) filter (where action = 'workspace.start_requested') as starts,
			count(*) filter (where action in
				('workspace.stop_requested', 'workspace.idle_stopped')) as stops,
			count(*) filter (where action = 'auth.login' and result = 'ok') as sign_ins
		from audit_events
		where action in (${sql.join(ACTIONS)})
			and at >= ${window.from} and at < ${window.to}
		group by 1
		order by 1
	`.execute(db);
	return result.rows
		.map((row) => ({
			at: new Date(row.at).toISOString(),
			throttles: Number(row.throttles),
			memoryFlags: Number(row.memory_flags),
			idleStops: Number(row.idle_stops),
			guardLifts: Number(row.guard_lifts),
			starts: Number(row.starts),
			stops: Number(row.stops),
			signIns: Number(row.sign_ins),
		}))
		.filter((point) =>
			// A bucket holding only failed sign-ins has nothing to show.
			Object.values(point).some((value) => typeof value === "number" && value > 0),
		);
}
