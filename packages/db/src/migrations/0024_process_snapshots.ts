import { type Kysely, sql } from "kysely";

/**
 * One administrator process snapshot per workspace (ADR 0037). The API writes
 * the request, the worker fills in the answer from Incus.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table workspace_process_snapshots (
		workspace_id uuid primary key references workspaces(id) on delete cascade,
		requested_at timestamptz not null,
		requested_by uuid references users(id) on delete set null,
		taken_at timestamptz,
		processes jsonb,
		error text
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table workspace_process_snapshots`.execute(db);
}
