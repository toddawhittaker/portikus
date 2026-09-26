import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { SeriesWindow } from "./range.js";

/** Stub until Epic 19 T3a: availability, running count, CPU, network, disk. */
export async function platformSeries(
	_db: Kysely<Database>,
	_window: SeriesWindow,
): Promise<HealthSeries["platform"]> {
	return [];
}
