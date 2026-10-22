import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { startLoop } from "./loop.js";

/** How often the worker sweeps old audit rows. */
export const AUDIT_PRUNE_SECONDS = 24 * 60 * 60;

/** Rows deleted per call, so one statement never holds a long lock. */
export const AUDIT_PRUNE_BATCH = 5000;

/**
 * Delete audit rows older than 365 days, one batch per call until none are
 * left, so each batch is its own short statement. Returns how many rows went.
 * The worker has no DELETE on audit_events; the database function that does
 * it fixes the 365 days itself (worker-grants.sql, SPEC.md section 25.10).
 */
export async function pruneAuditEvents(
	db: Kysely<Database>,
	batchSize: number = AUDIT_PRUNE_BATCH,
): Promise<number> {
	let total = 0;
	for (;;) {
		const { rows } = await sql<{
			deleted: number;
		}>`select public.prune_audit_events(${batchSize}) as deleted`.execute(db);
		const deleted = rows[0]?.deleted ?? 0;
		total += deleted;
		if (deleted < batchSize) return total;
	}
}

function createAuditRetention(options: {
	db: Kysely<Database>;
	logger: Logger;
}): () => Promise<void> {
	const { db, logger } = options;
	return async () => {
		try {
			// Only the count is logged, never row contents (STACK.md section 15).
			const deleted = await pruneAuditEvents(db);
			if (deleted > 0) logger.info({ deleted }, "pruned audit events");
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "audit retention error");
		}
	};
}

/** Sweep now and then once a day on its own timer; errors are logged, never thrown. */
export function startAuditRetention(
	options: { db: Kysely<Database>; logger: Logger },
	tick: () => Promise<void> = createAuditRetention(options),
): () => void {
	return startLoop("audit retention", options.logger, tick, AUDIT_PRUNE_SECONDS * 1000);
}
