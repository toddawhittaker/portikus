import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { SeriesWindow } from "./range.js";

/** Stub until Epic 19 T4: request counts, error counts and latency per bucket. */
export async function apiRequestSeries(
	_db: Kysely<Database>,
	_window: SeriesWindow,
): Promise<HealthSeries["api"]> {
	return [];
}
