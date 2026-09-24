import { type Kysely, sql } from "kysely";

/**
 * One-time setup codes for the first administrator (docs/EPIC-14.md rulings
 * 16 to 18; ADR 0028). Only the SHA-256 of a code is stored.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table setup_codes (
		id uuid primary key default gen_random_uuid(),
		code_hash text not null unique,
		created_at timestamptz not null default now(),
		expires_at timestamptz not null,
		used_at timestamptz,
		used_by uuid references users(id) on delete set null
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table setup_codes`.execute(db);
}
