import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { startLoop } from "./loop.js";

/** How often the worker prunes ended terminal rows. */
const TERMINAL_PRUNE_SECONDS = 60 * 60;

/** Ended terminal rows older than this are deleted. */
export const ENDED_TERMINAL_MAX_AGE_DAYS = 30;

/**
 * Delete terminal rows that ended more than 30 days ago (SPEC.md 9.7).
 * Open rows are never touched. Returns how many rows went.
 */
export async function pruneEndedTerminals(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const cutoff = new Date(now.getTime() - ENDED_TERMINAL_MAX_AGE_DAYS * 86_400_000);
	const result = await db
		.deleteFrom("terminals")
		.where("ended_at", "<", cutoff)
		.executeTakeFirst();
	return Number(result.numDeletedRows);
}

/** Prune now and every hour on its own timer; errors are logged, never thrown. */
export function startTerminalPrune(options: {
	db: Kysely<Database>;
	logger: Logger;
}): () => void {
	const { db, logger } = options;
	const tick = async (): Promise<void> => {
		try {
			const deleted = await pruneEndedTerminals(db, new Date());
			if (deleted > 0) logger.info({ deleted }, "pruned ended terminals");
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "terminal prune error");
		}
	};
	return startLoop("terminal prune", logger, tick, TERMINAL_PRUNE_SECONDS * 1000);
}
