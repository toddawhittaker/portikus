import { type Kysely, sql } from "kysely";

/**
 * The site switch for voice input (SPEC.md section 25.10, ADR 0055). On by
 * default, so a site that never touches it keeps the microphone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings add column voice_input_enabled boolean not null default true`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column voice_input_enabled`.execute(db);
}
