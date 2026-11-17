import { type Kysely, sql } from "kysely";

/** When the weekly administrator digest last went out (SPEC.md section 20.4); null until the first. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings add column digest_sent_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column digest_sent_at`.execute(db);
}
