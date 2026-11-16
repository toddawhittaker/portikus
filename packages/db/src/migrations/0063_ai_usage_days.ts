import { type Kysely, sql } from "kysely";

/**
 * Built-in AI token counts per UTC day, person, purpose and model, for the
 * site's monthly cap and the usage view (SPEC.md section 20.4). Counts only,
 * never content. A null `user_id` (a person since deleted, or a system call
 * such as the weekly price check) still counts toward the cap, and the
 * unique key treats nulls as equal so those rows add up in one place.
 * The worker has no grants.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table ai_usage_days (
		day date not null,
		user_id uuid references users (id) on delete set null,
		purpose text not null check (purpose in ('assistant', 'pricing')),
		model text not null check (char_length(model) between 1 and 100),
		input_tokens bigint not null default 0 check (input_tokens >= 0),
		output_tokens bigint not null default 0 check (output_tokens >= 0),
		cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
		cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
		unique nulls not distinct (day, user_id, purpose, model)
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table ai_usage_days`.execute(db);
}
