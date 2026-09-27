import { type Kysely, sql } from "kysely";

/** A copy of EGRESS_DEFAULT_BLOCKED_SITES in contracts: a migration must not change after it ships. */
const DOH_HOSTS = [
	"cloudflare-dns.com",
	"dns.adguard-dns.com",
	"dns.google",
	"dns.nextdns.io",
	"dns.quad9.net",
	"doh.cleanbrowsing.org",
	"doh.opendns.com",
	"one.one.one.one",
];

/**
 * Blocked sites for open mode (issue #284, ADR 0043). Their own table rather
 * than a kind on egress_entries, so the allow-list's unique names, limits and
 * code stay untouched. Seeded once with the public DNS over HTTPS services;
 * an administrator may remove them.
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
	for (const value of DOH_HOSTS) {
		await sql`insert into egress_blocked_entries (value, label)
			values (${value}, 'DNS over HTTPS service (default)')`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table egress_blocked_entries`.execute(db);
}
