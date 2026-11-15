import { type Database, recordNotification } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { startLoop } from "./loop.js";

/** How often the worker looks for API keys that are about to expire. */
export const API_KEY_REMINDER_SECONDS = 24 * 60 * 60;

const DAY_MS = 86_400_000;

/** Days before expiry a key's owner is reminded; 7-day keys get one day (docs/EPIC-68.md, D5). */
function reminderWindowDays(periodDays: number | null): number {
	return periodDays === 7 ? 1 : 7;
}

/**
 * Notify the owner of each API key that expires within its reminder window,
 * once per expiry: `expiry_reminded_for` records the `expires_at` already
 * reminded, so a renewal that moves `expires_at` arms the next reminder
 * (SPEC.md sections 24.8 and 24.13). Revoked, never-expiring and already
 * expired keys get none. Returns how many reminders went out. One key's
 * failure is logged and does not stop the others. The token hash is never
 * read.
 */
export async function remindExpiringApiKeys(
	db: Kysely<Database>,
	now: Date,
	logger: Logger,
): Promise<number> {
	const candidates = await db
		.selectFrom("api_keys")
		.select(["id", "user_id", "name", "display_prefix", "expires_at", "period_days"])
		.where("revoked_at", "is", null)
		.where("expires_at", ">", now)
		.where("expires_at", "<=", new Date(now.getTime() + 7 * DAY_MS))
		.where((eb) =>
			eb.or([
				eb("expiry_reminded_for", "is", null),
				eb("expiry_reminded_for", "!=", eb.ref("expires_at")),
			]),
		)
		.execute();

	let sent = 0;
	for (const key of candidates) {
		const expiresAt = key.expires_at;
		if (!expiresAt) continue;
		const windowMs = reminderWindowDays(key.period_days) * DAY_MS;
		if (expiresAt.getTime() - now.getTime() > windowMs) continue;
		try {
			await db.transaction().execute(async (trx) => {
				await recordNotification(trx, key.user_id, {
					tone: "warning",
					title: "An API key expires soon",
					body: `Your API key "${key.name}" (${key.display_prefix}) expires on ${expiresAt.toISOString().slice(0, 10)} (UTC). You can renew it from your settings.`,
				});
				await trx
					.updateTable("api_keys")
					.set({ expiry_reminded_for: expiresAt })
					.where("id", "=", key.id)
					.execute();
			});
			sent++;
		} catch (e) {
			// The key's name and prefix stay out of the log; only its id is named.
			logger.error({ keyId: key.id, error: errorMessage(e) }, "api key reminder error");
		}
	}
	return sent;
}

/** Remind now and once a day on its own timer; errors are logged, never thrown. */
export function startApiKeyReminders(
	options: { db: Kysely<Database>; logger: Logger },
	tick: () => Promise<void> = async () => {
		try {
			const sent = await remindExpiringApiKeys(options.db, new Date(), options.logger);
			if (sent > 0) options.logger.info({ sent }, "sent api key expiry reminders");
		} catch (e) {
			options.logger.error({ error: errorMessage(e) }, "api key reminders error");
		}
	},
): () => void {
	return startLoop(
		"api key reminders",
		options.logger,
		tick,
		API_KEY_REMINDER_SECONDS * 1000,
	);
}
