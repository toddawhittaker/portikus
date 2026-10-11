import { type Kysely, sql } from "kysely";

/**
 * Coding-agent usage counts per user, workspace-agent boot, UTC day, agent
 * and model (ADR 0057). Counts only, never content. A row holds its boot's
 * running total, so a repeated report overwrites it rather than adding.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table agent_usage_days (
		user_id uuid not null references users(id) on delete cascade,
		boot_id uuid not null,
		day date not null,
		agent text not null
			constraint agent_usage_days_agent_check check (agent in ('claude', 'codex')),
		model text not null
			constraint agent_usage_days_model_check
			check (char_length(model) between 1 and 100),
		sessions bigint not null default 0,
		input_tokens bigint not null default 0,
		output_tokens bigint not null default 0,
		cache_read_tokens bigint not null default 0,
		cache_write_tokens bigint not null default 0,
		cost_usd numeric null,
		lines_added bigint not null default 0,
		lines_removed bigint not null default 0,
		updated_at timestamptz not null default now(),
		constraint agent_usage_days_counts_check check (
			sessions >= 0 and input_tokens >= 0 and output_tokens >= 0
			and cache_read_tokens >= 0 and cache_write_tokens >= 0
			and (cost_usd is null or cost_usd >= 0)
			and lines_added >= 0 and lines_removed >= 0
		),
		primary key (user_id, boot_id, day, agent, model)
	)`.execute(db);
	// The usage views read a window of days, and the daily prune deletes by day.
	await sql`create index agent_usage_days_day_idx on agent_usage_days (day)`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table agent_usage_days`.execute(db);
}
