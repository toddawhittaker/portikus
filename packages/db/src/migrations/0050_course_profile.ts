import { type Kysely, sql } from "kysely";

/**
 * A course's interface profile (SPEC.md section 8.7, ADR 0066) and the site
 * switch for code help (SPEC.md section 13.6). Courses start agentic and code
 * help starts on, so a site that touches neither behaves as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table lti_contexts
			add column profile text not null default 'agentic',
			add constraint lti_contexts_profile_check
				check (profile in ('agentic', 'traditional'))`.execute(db);
	await sql`alter table settings add column code_help_enabled boolean not null default true`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column code_help_enabled`.execute(db);
	await sql`alter table lti_contexts drop constraint lti_contexts_profile_check`.execute(
		db,
	);
	await sql`alter table lti_contexts drop column profile`.execute(db);
}
