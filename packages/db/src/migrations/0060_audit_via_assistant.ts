import { type Kysely, sql } from "kysely";

/**
 * An audited request can now arrive through the built-in assistant
 * (SPEC.md section 24.11): `via` is `session`, `api_key` or `assistant`.
 * Going back turns assistant rows into `session`, because the assistant
 * acts with the caller's own session.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table audit_events drop constraint audit_events_via_check`.execute(
		db,
	);
	await sql`alter table audit_events
		add constraint audit_events_via_check
		check (via in ('session', 'api_key', 'assistant'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`update audit_events set via = 'session' where via = 'assistant'`.execute(
		db,
	);
	await sql`alter table audit_events drop constraint audit_events_via_check`.execute(
		db,
	);
	await sql`alter table audit_events
		add constraint audit_events_via_check
		check (via in ('session', 'api_key'))`.execute(db);
}
