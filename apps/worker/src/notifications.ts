import { MAX_NOTIFICATIONS_PER_USER } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";

/** How often the worker prunes notification history. */
export const NOTIFICATION_PRUNE_SECONDS = 60 * 60;

/** Notifications older than this are deleted. */
export const NOTIFICATION_MAX_AGE_DAYS = 90;

/**
 * Delete notifications older than 90 days and all but each user's newest 200
 * (SPEC.md section 8.5, ADR 0033). Returns how many rows went.
 */
export async function pruneNotifications(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const cutoff = new Date(now.getTime() - NOTIFICATION_MAX_AGE_DAYS * 86_400_000);
	const old = await db
		.deleteFrom("notifications")
		.where("created_at", "<", cutoff)
		.executeTakeFirst();
	const extra = await sql`delete from notifications where id in (
		select id from (
			select id, row_number() over (
				partition by user_id order by created_at desc, id desc
			) as n from notifications
		) ranked where n > ${MAX_NOTIFICATIONS_PER_USER}
	)`.execute(db);
	return Number(old.numDeletedRows) + Number(extra.numAffectedRows ?? 0n);
}

/** Prune now and every hour on its own timer; errors are logged, never thrown. */
export function startNotificationPrune(options: {
	db: Kysely<Database>;
	logger: Logger;
}): () => void {
	const { db, logger } = options;
	const tick = async (): Promise<void> => {
		try {
			const deleted = await pruneNotifications(db, new Date());
			if (deleted > 0) logger.info({ deleted }, "pruned notifications");
		} catch (e) {
			logger.error(
				{ error: e instanceof Error ? e.message : String(e) },
				"notification prune error",
			);
		}
	};
	const timer = setInterval(() => {
		void tick();
	}, NOTIFICATION_PRUNE_SECONDS * 1000);
	timer.unref();
	void tick();
	return () => clearInterval(timer);
}
