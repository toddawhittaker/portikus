import { type Kysely, sql } from "kysely";

/**
 * A student's live help session with one instructor in one project, and the
 * layout version that keeps two browsers on one project in step (ADR 0063).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table live_help_sessions (
		id uuid primary key default gen_random_uuid(),
		workspace_id uuid not null references workspaces(id) on delete cascade,
		project_id uuid not null references projects(id) on delete cascade,
		helper_user_id uuid not null references users(id) on delete cascade,
		course_id uuid not null references lti_contexts(id) on delete cascade,
		typing boolean not null default false,
		started_at timestamptz not null default now(),
		ends_at timestamptz not null,
		ended_at timestamptz null,
		-- Why it ended, so the student's browser can say so (ADR 0063).
		end_reason text null,
		constraint live_help_sessions_ends_after_start check (ends_at > started_at)
	)`.execute(db);
	// A session past its end time still holds this slot until ended_at closes it.
	await sql`create unique index live_help_one_open
		on live_help_sessions (workspace_id)
		where ended_at is null`.execute(db);

	// An instructor's preview lives only as long as the session that allowed it.
	await sql`alter table preview_grants add column live_help_session_id uuid null
		references live_help_sessions(id) on delete cascade`.execute(db);
	await sql`alter table preview_sessions add column live_help_session_id uuid null
		references live_help_sessions(id) on delete cascade`.execute(db);

	await sql`alter table projects add column layout_version integer not null default 0`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table projects drop column layout_version`.execute(db);
	await sql`alter table preview_sessions drop column live_help_session_id`.execute(db);
	await sql`alter table preview_grants drop column live_help_session_id`.execute(db);
	await sql`drop table live_help_sessions`.execute(db);
}
