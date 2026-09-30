import { type Kysely, sql } from "kysely";

/**
 * Shared Docker pull storage (issue #840): the admin settings, the current
 * seed, seed rebuild jobs and the aggregate usage the worker collects. The
 * usage tables hold a workspace id so a workspace counts once per image;
 * the admin report returns counts only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column docker_ghcr_enabled boolean not null default false,
		add column docker_seed_max_gib integer not null default 8,
		add column docker_seed_images jsonb not null default '[]'`.execute(db);
	await sql`create table docker_seed (
		id integer primary key default 1 check (id = 1),
		images jsonb not null,
		size_bytes bigint not null,
		image_version text not null,
		built_at timestamptz not null
	)`.execute(db);
	await sql`create table docker_seed_jobs (
		id uuid primary key default gen_random_uuid(),
		state text not null default 'queued',
		step text not null default 'Waiting to start',
		images jsonb not null,
		message text,
		requested_by uuid references users(id) on delete set null,
		requested_at timestamptz not null default now(),
		finished_at timestamptz
	)`.execute(db);
	// At most one job queued or running, even if two requests race.
	await sql`create unique index docker_seed_jobs_one_active
		on docker_seed_jobs ((true)) where state in ('queued', 'running')`.execute(db);
	await sql`create table docker_image_pulls (
		image text not null,
		workspace_id uuid not null references workspaces(id) on delete cascade,
		pulls int not null default 0,
		first_seen timestamptz not null default now(),
		last_seen timestamptz not null default now(),
		primary key (image, workspace_id)
	)`.execute(db);
	await sql`create table docker_image_presence (
		workspace_id uuid not null references workspaces(id) on delete cascade,
		image text not null,
		in_seed boolean not null,
		used boolean not null,
		sampled_at timestamptz not null default now(),
		primary key (workspace_id, image)
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table docker_image_presence`.execute(db);
	await sql`drop table docker_image_pulls`.execute(db);
	await sql`drop table docker_seed_jobs`.execute(db);
	await sql`drop table docker_seed`.execute(db);
	await sql`alter table settings
		drop column docker_seed_images,
		drop column docker_seed_max_gib,
		drop column docker_ghcr_enabled`.execute(db);
}
