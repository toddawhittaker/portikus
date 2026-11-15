import { type Kysely, sql } from "kysely";

/**
 * Finished check runs, kept so a result outlives the workspace agent
 * ("Check result metadata", SPEC.md §25). The API keeps the newest 20 per
 * check per project and at most 64 KiB of each run's output.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table check_runs (
		id uuid primary key default gen_random_uuid(),
		project_id uuid not null references projects(id) on delete cascade,
		check_id text not null,
		agent_run_id text not null,
		state text not null check (state in ('passed', 'failed', 'error', 'stopped')),
		started_at timestamptz not null,
		ended_at timestamptz not null,
		exit_code integer,
		output bytea not null default ''::bytea check (octet_length(output) <= 65536),
		unique (project_id, check_id, agent_run_id)
	)`.execute(db);
	await sql`create index check_runs_by_check on check_runs
		(project_id, check_id, started_at desc)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table check_runs`.execute(db);
}
