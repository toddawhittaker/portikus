import type { NotificationTone } from "@portikus/contracts";
import { type Database, notifyAdministrators, recordAudit } from "@portikus/db";
import { type Kysely, sql } from "kysely";

export interface OnceNotice {
	action: string;
	target: string;
	title: string;
	body: string;
	/** Defaults to "release-check" and "neutral". */
	actor?: string;
	tone?: NotificationTone;
}

/**
 * One neutral notification per enabled administrator, the first time this
 * action and target are seen. The audit row is the record that it was sent.
 */
export async function notifyOnce(
	db: Kysely<Database>,
	notice: OnceNotice,
): Promise<boolean> {
	return db.transaction().execute(async (trx) => {
		// The hourly timer and a page load can race; this makes the check and insert one step.
		await sql`select pg_advisory_xact_lock(hashtext('portikus.release-notice'))`.execute(
			trx,
		);
		const seen = await trx
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", notice.action)
			.where("target", "=", notice.target)
			.executeTakeFirst();
		if (seen) return false;
		await recordAudit(trx, {
			actor: notice.actor ?? "release-check",
			target: notice.target,
			action: notice.action,
			result: "ok",
			metadata: {},
		});
		await notifyAdministrators(trx, {
			tone: notice.tone ?? "neutral",
			title: notice.title,
			body: notice.body,
		});
		return true;
	});
}
