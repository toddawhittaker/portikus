import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { SeriesWindow } from "./range.js";

/** Stub until Epic 19 T3b: guard events and activity counts per bucket. */
export async function eventSeries(
	_db: Kysely<Database>,
	_window: SeriesWindow,
): Promise<HealthSeries["events"]> {
	return [];
}
