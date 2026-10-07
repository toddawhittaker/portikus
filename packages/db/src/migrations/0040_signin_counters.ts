import { type Kysely, sql } from "kysely";

/**
 * Sign-in guess counts (SPEC.md section 24.13, ADR 0053): one fixed window
 * per scope and key, so a restart of the API hands out no fresh guesses.
 * The worker deletes a row once `expires_at` has passed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table signin_counters (
		scope text not null,
		key text not null,
		window_started_at timestamptz not null,
		expires_at timestamptz not null,
		count integer not null,
		reported boolean not null default false,
		primary key (scope, key)
	)`.execute(db);
	await sql`create index signin_counters_expires_idx
		on signin_counters (expires_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table signin_counters`.execute(db);
}
