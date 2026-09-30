import { type Kysely, sql } from "kysely";

/**
 * The ghcr.io pull-through cache is on by default (Epic 26, ruling S3 as
 * revised). No site relied on it being off, so the existing row turns on too.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings alter column docker_ghcr_enabled set default true`.execute(
		db,
	);
	await sql`update settings set docker_ghcr_enabled = true`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings alter column docker_ghcr_enabled set default false`.execute(
		db,
	);
}
