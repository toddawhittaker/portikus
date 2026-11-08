import { type Kysely, sql } from "kysely";

/** The chat picker values the owner last used in a project (SPEC.md §10.8); null until set. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table projects add column chat_settings jsonb null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table projects drop column chat_settings`.execute(db);
}
