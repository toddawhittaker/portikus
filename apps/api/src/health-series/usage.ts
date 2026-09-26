import type { HealthSeries } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { SeriesWindow } from "./range.js";

/** Stub until Epic 19 T3b: the per-workspace heat map. */
export async function usageSeries(
	_db: Kysely<Database>,
	window: SeriesWindow,
): Promise<HealthSeries["usage"]> {
	return { retentionMinutes: 0, from: window.from.toISOString(), workspaces: [] };
}
