import { type Kysely, sql } from "kysely";

/**
 * API prices per model, kept by administrators (SPEC.md sections 10.8 and
 * 20.4). The dollar price is per million input tokens. Cache figures are
 * ratios of that price: `cache_write_ratio` goes with `cache_ttl_seconds`,
 * the model's default cache lifetime, and `cache_write_one_hour_ratio` is
 * the one-hour write where the provider sells one. A surcharge multiplies
 * every price on a message whose context passes `surcharge_above_tokens`;
 * the two surcharge columns are both set or both empty. Each row names the
 * page and the quoted sentence its figures came from. A weekly or manual
 * run writes `price_proposals`, and an administrator accepts or rejects
 * each into `model_prices`. The worker has no grants.
 */
const PRICE_COLUMNS = `
	provider text not null check (provider in ('anthropic', 'openai')),
	model text not null check (char_length(model) between 1 and 200),
	input_price_per_million numeric not null
		check (input_price_per_million > 0 and input_price_per_million <= 10000),
	cache_read_ratio numeric not null
		check (cache_read_ratio > 0 and cache_read_ratio <= 1),
	cache_write_ratio numeric not null
		check (cache_write_ratio > 0 and cache_write_ratio <= 10),
	cache_write_one_hour_ratio numeric
		check (cache_write_one_hour_ratio > 0 and cache_write_one_hour_ratio <= 10),
	cache_ttl_seconds integer not null
		check (cache_ttl_seconds > 0 and cache_ttl_seconds <= 86400),
	surcharge_above_tokens integer check (surcharge_above_tokens > 0),
	surcharge_factor numeric check (surcharge_factor > 1 and surcharge_factor <= 10),
	source_url text not null check (char_length(source_url) > 0),
	source_quote text not null check (char_length(source_quote) between 1 and 2000),
	check ((surcharge_above_tokens is null) = (surcharge_factor is null))`;

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table model_prices (
		id uuid primary key default gen_random_uuid(),
		${sql.raw(PRICE_COLUMNS)},
		checked_at timestamptz not null default now(),
		updated_at timestamptz not null default now(),
		updated_by uuid references users (id) on delete set null,
		unique (provider, model)
	)`.execute(db);
	await sql`create table price_runs (
		id uuid primary key default gen_random_uuid(),
		trigger text not null check (trigger in ('manual', 'weekly')),
		status text not null default 'running'
			check (status in ('running', 'done', 'failed')),
		started_at timestamptz not null default now(),
		finished_at timestamptz,
		error_code text,
		started_by uuid references users (id) on delete set null
	)`.execute(db);
	await sql`create table price_proposals (
		id uuid primary key default gen_random_uuid(),
		run_id uuid not null references price_runs (id) on delete cascade,
		${sql.raw(PRICE_COLUMNS)},
		status text not null default 'pending'
			check (status in ('pending', 'accepted', 'rejected')),
		decided_at timestamptz,
		decided_by uuid references users (id) on delete set null
	)`.execute(db);
	await sql`create index price_proposals_run_idx on price_proposals (run_id)`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table price_proposals`.execute(db);
	await sql`drop table price_runs`.execute(db);
	await sql`drop table model_prices`.execute(db);
}
