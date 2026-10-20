import { type Kysely, sql } from "kysely";

/**
 * Emailed reset and invitation links (SPEC.md section 5.3). Only a token's
 * SHA-256 is stored; the API deletes a row once it has ended. The worker
 * has no rights on this table (worker-grants.sql). The site switch is off
 * by default, so SMTP set for alerts alone never emails students.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table account_email_tokens (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users (id) on delete cascade,
		purpose text not null check (purpose in ('reset', 'invite')),
		token_hash text not null unique,
		created_by uuid null references users (id) on delete set null,
		created_at timestamptz not null default now(),
		expires_at timestamptz not null,
		used_at timestamptz,
		revoked_at timestamptz
	)`.execute(db);
	await sql`create index account_email_tokens_user_idx
		on account_email_tokens (user_id, purpose)`.execute(db);
	await sql`create index account_email_tokens_expires_idx
		on account_email_tokens (expires_at)`.execute(db);
	await sql`alter table settings add column account_email_enabled boolean not null default false`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings drop column account_email_enabled`.execute(db);
	await sql`drop table account_email_tokens`.execute(db);
}
