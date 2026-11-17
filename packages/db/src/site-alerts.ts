import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/**
 * Warning and danger site alerts to administrators, one row per alert with
 * the time of its newest row. `notifyAdministrators` writes a row for each
 * administrator; the worker forwards alerts and the API explains them from
 * this one query. Callers add their own time and triage filters.
 */
export function adminAlertGroups(db: Kysely<Database>) {
	return (
		db
			.selectFrom("notifications")
			.innerJoin("users", "users.id", "notifications.user_id")
			.select(["notifications.title", "notifications.body", "notifications.tone"])
			.select((eb) => eb.fn.max("notifications.created_at").as("at"))
			.where("users.role", "=", "administrator")
			// Personal notices to an administrator are not site alerts.
			.where("notifications.site_alert", "=", true)
			.where("notifications.tone", "in", ["warning", "danger"])
			.groupBy(["notifications.title", "notifications.body", "notifications.tone"])
	);
}
