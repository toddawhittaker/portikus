import { MAX_NOTIFICATIONS_PER_USER, type NotificationTone } from "@portikus/contracts";
import type { Database, NotificationsTable } from "@portikus/db";
import type { Kysely, Selectable } from "kysely";

/**
 * Record one notification for a user and keep only their newest rows
 * (ADR 0033). The API also uses it to tell a student something happened.
 */
export async function recordNotification(
	db: Kysely<Database>,
	userId: string,
	notification: { tone: NotificationTone; title: string; body: string },
): Promise<Selectable<NotificationsTable>> {
	const row = await db
		.insertInto("notifications")
		.values({
			user_id: userId,
			tone: notification.tone,
			title: notification.title,
			body: notification.body,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	// Keep only this user's newest rows; the worker also prunes by age.
	await db
		.deleteFrom("notifications")
		.where("user_id", "=", userId)
		.where("id", "not in", (eb) =>
			eb
				.selectFrom("notifications")
				.select("id")
				.where("user_id", "=", userId)
				.orderBy("created_at", "desc")
				.orderBy("id", "desc")
				.limit(MAX_NOTIFICATIONS_PER_USER),
		)
		.execute();
	return row;
}
