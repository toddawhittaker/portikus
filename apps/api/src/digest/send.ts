import type { Database } from "@portikus/db";
import { notifyAdministrators } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { composeDigest } from "./compose.js";
import { digestDue, latestMondayEight } from "./week.js";

const TICK_MS = 10 * 60_000;

/**
 * One tick of the weekly digest (SPEC.md section 20.4). Claims the week by
 * stamping `settings.digest_sent_at` first, so a second tick or a restart
 * cannot send it again; a failed send puts the old stamp back so the next
 * tick tries again.
 */
export async function digestTick(
	db: Kysely<Database>,
	now: Date = new Date(),
): Promise<"not-due" | "sent"> {
	const row = await db
		.selectFrom("settings")
		.select("digest_sent_at")
		.where("id", "=", 1)
		.executeTakeFirst();
	// The worker seeds settings; with no row there is nowhere to record a send.
	if (!row || !digestDue(row.digest_sent_at, now)) return "not-due";
	const claimed = await db
		.updateTable("settings")
		.set({ digest_sent_at: now.toISOString() })
		.where("id", "=", 1)
		.where((eb) =>
			eb.or([
				eb("digest_sent_at", "is", null),
				eb("digest_sent_at", "<", latestMondayEight(now)),
			]),
		)
		.executeTakeFirst();
	if (claimed.numUpdatedRows === 0n) return "not-due";
	try {
		const body = await composeDigest(db, now);
		await notifyAdministrators(db, { tone: "neutral", title: "Weekly summary", body });
	} catch (error) {
		await db
			.updateTable("settings")
			.set({ digest_sent_at: row.digest_sent_at?.toISOString() ?? null })
			.where("id", "=", 1)
			.execute();
		throw error;
	}
	return "sent";
}

/** The timer that checks every ten minutes whether Monday 08:00 has passed; returns the stop function. */
export function startDigestTimer(db: Kysely<Database>, logger: Logger): () => void {
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		digestTick(db)
			.catch((error: unknown) =>
				logger.error({ error: errorMessage(error) }, "weekly digest error"),
			)
			.finally(() => {
				busy = false;
			});
	}, TICK_MS);
	timer.unref();
	return () => clearInterval(timer);
}
