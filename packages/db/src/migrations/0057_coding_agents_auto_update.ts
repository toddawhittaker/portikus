import { type Kysely, sql } from "kysely";

/** Whether the API updates the shared coding agents each night (SPEC.md section 22.6); off until an administrator turns it on. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column coding_agents_auto_update boolean not null default false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column coding_agents_auto_update`.execute(db);
}
