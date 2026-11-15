import { type Kysely, sql } from "kysely";

/**
 * API keys for administrators and instructors (SPEC.md sections 24.8 and
 * 24.13). Only a key's SHA-256 is stored, with a short display prefix so a
 * person can tell their keys apart. A null `expires_at` means the key never
 * expires; `period_days` is the length it restarts with on each renewal.
 * `expiry_reminded_for` records which expiry the daily reminder was sent
 * for. The worker may read the table and update that one column
 * (worker-grants.sql).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table api_keys (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users (id) on delete cascade,
		name text not null check (char_length(name) between 1 and 100),
		token_hash text not null unique,
		display_prefix text not null,
		scope text not null default 'read'
			check (scope in ('read', 'write', 'destructive')),
		period_days integer check (period_days > 0),
		created_at timestamptz not null default now(),
		expires_at timestamptz,
		last_used_at timestamptz,
		revoked_at timestamptz,
		revoked_by uuid references users (id) on delete set null,
		expiry_reminded_for timestamptz
	)`.execute(db);
	await sql`create index api_keys_user_idx on api_keys (user_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table api_keys`.execute(db);
}
