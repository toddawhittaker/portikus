import { type Kysely, sql } from "kysely";

/**
 * Keep running until (issue #955, Epic 28 ruling R1): a student's hold over
 * the disconnect grace and idle stop, and the site cap on how far ahead it
 * may reach, in hours (0 turns holds off).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table workspaces add column keep_running_until timestamptz null`.execute(
		db,
	);
	await sql`
		alter table settings add column keep_running_max_hours integer not null default 12
			check (keep_running_max_hours between 0 and 168)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column keep_running_max_hours`.execute(db);
	await sql`alter table workspaces drop column keep_running_until`.execute(db);
}
