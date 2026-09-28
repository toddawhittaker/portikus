import { type Kysely, sql } from "kysely";

/**
 * Blocked sites for open mode (issue #284, ADR 0043). Their own table rather
 * than a kind on egress_entries, so the allow-list's unique names, limits and
 * code stay untouched. Created empty: open mode stays as it was until an
 * administrator blocks a site.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table egress_blocked_entries (
		id uuid primary key default gen_random_uuid(),
		value text not null unique,
		label text not null default '',
		created_by uuid references users(id) on delete set null,
		created_at timestamptz not null default now(),
		updated_at timestamptz not null default now()
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table egress_blocked_entries`.execute(db);
}
