import { type Kysely, sql } from "kysely";

/** A student's read-only share of one project with their instructors (ADR 0057). */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table project_shares (
		id uuid primary key default gen_random_uuid(),
		project_id uuid not null references projects(id) on delete cascade,
		started_at timestamptz not null default now(),
		ends_at timestamptz not null,
		ended_at timestamptz null,
		constraint project_shares_ends_after_start check (ends_at > started_at)
	)`.execute(db);
	// A share past its end time still holds this slot until ended_at closes it.
	await sql`create unique index project_shares_one_open
		on project_shares (project_id)
		where ended_at is null`.execute(db);

	// Who looked, so the student can see it; one row per share and viewer.
	await sql`create table project_share_views (
		share_id uuid not null references project_shares(id) on delete cascade,
		viewer_user_id uuid not null references users(id) on delete cascade,
		first_viewed_at timestamptz not null default now(),
		last_viewed_at timestamptz not null default now(),
		primary key (share_id, viewer_user_id)
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table project_share_views`.execute(db);
	await sql`drop table project_shares`.execute(db);
}
