import { type Kysely, sql } from "kysely";

/** Roster sync and Deep Linking (ADR 0058). */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Filled by each launch; roster sync needs both, and records how its last run went.
	await sql`alter table lti_contexts
		add column platform_client_id text,
		add column nrps_url text,
		add column roster_synced_at timestamptz,
		add column roster_sync_result text`.execute(db);

	// People on the LMS roster, replaced on each sync; no email is kept.
	await sql`create table lti_roster_members (
		context_id uuid not null references lti_contexts(id) on delete cascade,
		subject text not null,
		display_name text not null,
		role text not null
			constraint lti_roster_members_role_check
			check (role in ('student', 'instructor')),
		primary key (context_id, subject)
	)`.execute(db);

	// A pending picker: ten minutes, single use; only the handle's hash is kept.
	await sql`create table lti_deep_link_requests (
		state_hash text primary key,
		platform_issuer text not null,
		subject text null,
		client_id text not null,
		deployment_id text not null,
		return_url text not null,
		data text null,
		expires_at timestamptz not null
	)`.execute(db);
	await sql`create index lti_deep_link_requests_expires_at_idx
		on lti_deep_link_requests (expires_at)`.execute(db);

	// A student's launch of a picked link, bound to that user until the project opens.
	await sql`create table lti_starter_launches (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users(id) on delete cascade,
		project_name text not null,
		template text null,
		repository_url text null,
		created_at timestamptz not null default now(),
		expires_at timestamptz not null,
		constraint lti_starter_launches_one_source
			check ((template is null) <> (repository_url is null))
	)`.execute(db);
	await sql`create index lti_starter_launches_expires_at_idx
		on lti_starter_launches (expires_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table lti_starter_launches`.execute(db);
	await sql`drop table lti_deep_link_requests`.execute(db);
	await sql`drop table lti_roster_members`.execute(db);
	await sql`alter table lti_contexts
		drop column roster_sync_result,
		drop column roster_synced_at,
		drop column nrps_url,
		drop column platform_client_id`.execute(db);
}
