import { type Kysely, sql } from "kysely";

/**
 * Each seed image's unpacked on-disk size as the seed build measured it,
 * keyed by canonical image name (SPEC.md section 16.6). Null for a seed
 * built before sizes were measured.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table docker_seed add column image_bytes jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table docker_seed drop column image_bytes`.execute(db);
}
