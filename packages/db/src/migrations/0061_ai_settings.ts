import { type Kysely, sql } from "kysely";

/**
 * The site's built-in AI settings (SPEC.md section 20.4): one row, switched
 * off until an administrator saves a provider and accepts the privacy
 * notice. The key is sealed with `sealSecret` and never read back; only its
 * last four characters are kept for display. The worker has no grants on
 * this table (worker-grants.sql revokes everything first).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table ai_settings (
		id integer primary key default 1 check (id = 1),
		enabled boolean not null default false,
		provider_kind text check (provider_kind in ('openai-compatible', 'anthropic')),
		base_url text,
		model text,
		key_sealed text,
		key_hint text check (char_length(key_hint) between 1 and 4),
		monthly_token_cap bigint not null default 5000000 check (monthly_token_cap >= 0),
		conversation_token_budget integer not null default 200000
			check (conversation_token_budget > 0),
		notice_version integer,
		notice_accepted_by uuid references users (id) on delete set null,
		notice_accepted_at timestamptz,
		price_sources text[] not null default '{}',
		updated_at timestamptz not null default now(),
		updated_by uuid references users (id) on delete set null,
		check ((key_sealed is null) = (key_hint is null))
	)`.execute(db);
	await sql`insert into ai_settings default values`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table ai_settings`.execute(db);
}
