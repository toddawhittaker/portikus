import { type Kysely, sql } from "kysely";

/**
 * Start retries the worker has spent on a workspace, and when the worker last
 * confirmed the workspace controller answers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table workspaces add column start_retries smallint not null default 0
			check (start_retries >= 0)
	`.execute(db);
	await sql`alter table settings add column controller_checked_at timestamptz null`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column controller_checked_at`.execute(db);
	await sql`alter table workspaces drop column start_retries`.execute(db);
}
