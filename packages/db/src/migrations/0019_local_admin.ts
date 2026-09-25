import { type Kysely, sql } from "kysely";

/**
 * The "must change password" flag and the end of the setup code
 * (docs/EPIC-14-2.md, "Data model and configuration"; ADR 0031).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table users add column must_change_password boolean not null default false`.execute(
		db,
	);
	await sql`drop table setup_codes`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Exactly as 0018_setup_codes made it, empty.
	await sql`create table setup_codes (
		id uuid primary key default gen_random_uuid(),
		code_hash text not null unique,
		created_at timestamptz not null default now(),
		expires_at timestamptz not null,
		used_at timestamptz,
		used_by uuid references users(id) on delete set null
	)`.execute(db);
	await sql`alter table users drop column must_change_password`.execute(db);
}
