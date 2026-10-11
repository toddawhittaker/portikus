import { type AuditEvent, type Database, recordAudit } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/**
 * Write each event whose target has no `action` row yet, so a root job's
 * end is audited once (SPEC.md 24.11). Two readers can see the same job
 * end at once; the lock makes the check and the insert one step.
 */
export async function recordAuditOnce(
	db: Kysely<Database>,
	action: string,
	events: Array<Omit<AuditEvent, "action">>,
): Promise<void> {
	if (events.length === 0) return;
	await db.transaction().execute(async (trx) => {
		await sql`select pg_advisory_xact_lock(hashtext(${`portikus.once.${action}`}))`.execute(
			trx,
		);
		const seen = await trx
			.selectFrom("audit_events")
			.select("target")
			.where("action", "=", action)
			.where(
				"target",
				"in",
				events.map((event) => event.target),
			)
			.execute();
		const seenTargets = new Set(seen.map((row) => row.target));
		for (const event of events) {
			if (seenTargets.has(event.target)) continue;
			await recordAudit(trx, { ...event, action });
		}
	});
}
