import { type Kysely, sql } from "kysely";

/**
 * How an audited request arrived (SPEC.md section 24.11): `via` is
 * `session` or `api_key`, and `api_key_id` names the key. Neither has a
 * foreign key, like `actor`, so a row outlives the key. Rows written before
 * this and by the worker leave both empty.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table audit_events
		add column via text check (via in ('session', 'api_key')),
		add column api_key_id uuid`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table audit_events drop column api_key_id, drop column via`.execute(
		db,
	);
}
