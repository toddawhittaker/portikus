import { type Kysely, sql } from "kysely";

/**
 * The workspace egress policy (issue #284; SPEC.md section 24.9). Blocked-name
 * counts are site-wide aggregates with no workspace, user or address column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column egress_mode text not null default 'open'
			constraint settings_egress_mode_check check (egress_mode in ('open', 'allow-list')),
		add column egress_presets text[] not null default '{}',
		add column egress_ports int[] not null default '{22,80,443}',
		add column egress_version int not null default 0,
		add column egress_applied_version int,
		add column egress_applied_at timestamptz,
		add column egress_apply_error text`.execute(db);
	await sql`create table egress_entries (
		id uuid primary key default gen_random_uuid(),
		kind text not null check (kind in ('host', 'range')),
		value text not null unique,
		label text not null default '',
		created_by uuid references users(id) on delete set null,
		created_at timestamptz not null default now(),
		updated_at timestamptz not null default now()
	)`.execute(db);
	await sql`create table egress_blocked_names (
		day date not null,
		name text not null,
		source text not null check (source in ('dns', 'tls')),
		count int not null default 0,
		primary key (day, name, source)
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table egress_blocked_names`.execute(db);
	await sql`drop table egress_entries`.execute(db);
	await sql`alter table settings
		drop column egress_apply_error,
		drop column egress_applied_at,
		drop column egress_applied_version,
		drop column egress_version,
		drop column egress_ports,
		drop column egress_presets,
		drop column egress_mode`.execute(db);
}
