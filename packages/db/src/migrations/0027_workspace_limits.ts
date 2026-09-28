import { type Kysely, sql } from "kysely";

/**
 * Per-workspace CPU, memory and process limits (SPEC.md section 20.1). The
 * API writes `limits_config`; the worker applies it to the instance and
 * records `limits_applied`. Null, or a missing key, uses the Incus profile.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table workspaces
		add column limits_config jsonb,
		add column limits_applied jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table workspaces
		drop column limits_config,
		drop column limits_applied`.execute(db);
}
