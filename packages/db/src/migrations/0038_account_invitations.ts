import { type Kysely, sql } from "kysely";

/**
 * Invitations: the only way an account from an upstream sign-in provider
 * is created (SPEC.md section 24.13). One active invitation per email.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table account_invitations (
		id uuid primary key default gen_random_uuid(),
		email text not null
			constraint account_invitations_email_lower check (email = lower(email)),
		username text null,
		display_name text not null,
		role text not null
			constraint account_invitations_role_check
			check (role in ('student', 'instructor', 'administrator')),
		created_by uuid null references users(id) on delete set null,
		created_at timestamptz not null default now(),
		claimed_by uuid null references users(id) on delete set null,
		claimed_at timestamptz null,
		revoked_at timestamptz null
	)`.execute(db);
	await sql`create unique index account_invitations_active_email
		on account_invitations (email)
		where claimed_at is null and revoked_at is null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table account_invitations`.execute(db);
}
