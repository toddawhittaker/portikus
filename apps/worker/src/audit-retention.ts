import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { startLoop } from "./loop.js";

/** How often the worker sweeps old audit rows. */
export const AUDIT_PRUNE_SECONDS = 24 * 60 * 60;

/** Audit rows older than this are deleted, whatever their action (SPEC.md section 25.10). */
export const AUDIT_RETENTION_DAYS = 365;

/** Rows deleted per statement, so one statement never holds a long lock. */
export const AUDIT_PRUNE_BATCH = 5000;

/**
 * Delete audit rows older than AUDIT_RETENTION_DAYS, one batch at a time until
 * none are left. Returns how many rows went. The worker may read only the
 * action, result and at columns (worker-grants.sql), so a batch is found by
 * time: every old row up to the batchSize-th oldest, equal times included.
 */
export async function pruneAuditEvents(
	db: Kysely<Database>,
	now: Date,
	batchSize: number = AUDIT_PRUNE_BATCH,
): Promise<number> {
	const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
	let total = 0;
	for (;;) {
		const batch = await sql`delete from audit_events where at <= (
			select at from audit_events where at < ${cutoff}
			order by at limit 1 offset ${batchSize - 1}
		)`.execute(db);
		const deleted = Number(batch.numAffectedRows ?? 0n);
		total += deleted;
		// No batch edge means fewer than a batch is left: delete the rest.
		if (deleted > 0) continue;
		const rest = await db
			.deleteFrom("audit_events")
			.where("at", "<", cutoff)
			.executeTakeFirst();
		return total + Number(rest.numDeletedRows);
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
			const deleted = await pruneAuditEvents(db, new Date());
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
