import { type Kysely, sql } from "kysely";

/**
 * Code help becomes a set of languages (SPEC.md section 13.6, ADR 0067). The
 * old on/off switch carries over: off becomes the empty set, on becomes both
 * languages that exist today. Ids are not constrained here; the API checks
 * them on write and readers drop ones they do not know.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table settings
			add column code_help_languages text[] not null default '{python,typescript}'`.execute(
		db,
	);
	await sql`update settings set code_help_languages = '{}' where not code_help_enabled`.execute(
		db,
	);
	await sql`alter table settings drop column code_help_enabled`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings add column code_help_enabled boolean not null default true`.execute(
		db,
	);
	await sql`update settings set code_help_enabled = cardinality(code_help_languages) > 0`.execute(
		db,
	);
	await sql`alter table settings drop column code_help_languages`.execute(db);
}
