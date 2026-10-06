import { type Kysely, sql } from "kysely";

/**
 * Two notification flags (SPEC.md sections 24.12 and 24.13): `site_alert`
 * marks the rows `notifyAdministrators` writes, the only ones the worker
 * forwards off the site; `kept` marks a notice its holder cannot delete,
 * such as a credential reset by an administrator.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table notifications
		add column site_alert boolean not null default false,
		add column kept boolean not null default false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table notifications drop column site_alert, drop column kept`.execute(
		db,
	);
}
