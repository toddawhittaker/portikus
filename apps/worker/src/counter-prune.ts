import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { startLoop } from "./loop.js";

/** How often the worker deletes sign-in counts whose window has ended. */
const COUNTER_PRUNE_SECONDS = 60 * 60;

/**
 * Delete sign-in counts whose window has ended (ADR 0053). A live window is
 * never touched, and the API restarts an ended one it meets before this
 * runs. Returns how many rows went.
 */
export async function pruneExpiredCounters(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const result = await db
		.deleteFrom("signin_counters")
		.where("expires_at", "<=", now)
		.executeTakeFirst();
	return Number(result.numDeletedRows);
}

/** Prune now and every hour on its own timer; errors are logged, never thrown. */
export function startCounterPrune(options: {
	db: Kysely<Database>;
	logger: Logger;
}): () => void {
	const { db, logger } = options;
	const tick = async (): Promise<void> => {
		try {
			const deleted = await pruneExpiredCounters(db, new Date());
			if (deleted > 0) logger.info({ deleted }, "pruned ended sign-in counts");
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "sign-in count prune error");
		}
	};
	return startLoop("sign-in count prune", logger, tick, COUNTER_PRUNE_SECONDS * 1000);
}
