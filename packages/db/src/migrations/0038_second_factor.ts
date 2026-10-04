import { type Kysely, sql } from "kysely";

/**
 * Second factors for Dex local-password accounts (SPEC.md section 24.13):
 * the factors, the single-use recovery codes, and when a session passed
 * the second-factor check.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table user_second_factors (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users(id) on delete cascade,
		kind text not null
			constraint user_second_factors_kind_check
			check (kind in ('totp', 'webauthn')),
		secret text not null,
		label text not null,
		last_step bigint null,
		created_at timestamptz not null default now(),
		last_used_at timestamptz null
	)`.execute(db);
	await sql`create index user_second_factors_user_idx
		on user_second_factors (user_id)`.execute(db);
	await sql`create table user_recovery_codes (
		user_id uuid not null references users(id) on delete cascade,
		code_hash text not null,
		used_at timestamptz null,
		primary key (user_id, code_hash)
	)`.execute(db);
	await sql`alter table sessions add column second_factor_at timestamptz null`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table sessions drop column second_factor_at`.execute(db);
	await sql`drop table user_recovery_codes`.execute(db);
	await sql`drop table user_second_factors`.execute(db);
}
