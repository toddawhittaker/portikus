import { type Kysely, sql } from "kysely";

/**
 * Backups run from the admin page (SPEC.md §24.9; ADR 0024). The API writes a
 * request, the host channel claims it and reports back into `backup_status`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table backup_requests (
		id uuid primary key default gen_random_uuid(),
		kind text not null constraint backup_requests_kind_check check (kind in
			('backup','delete_set','delete_dump','restore_copy','import_home',
			 'delete_snapshot','delete_kept_home')),
		args jsonb not null default '{}',
		state text not null default 'pending'
			constraint backup_requests_state_check
			check (state in ('pending','claimed','done','failed')),
		requested_by uuid references users(id) on delete set null,
		requested_at timestamptz not null default now(),
		claimed_at timestamptz,
		finished_at timestamptz,
		error text,
		workspace_id uuid references workspaces(id) on delete set null,
		result jsonb
	)`.execute(db);
	// One backup waiting or running at a time.
	await sql`create unique index backup_requests_one_backup_idx
		on backup_requests (kind)
		where kind = 'backup' and state in ('pending','claimed')`.execute(db);
	await sql`create index backup_requests_requested_idx
		on backup_requests (requested_at desc)`.execute(db);

	await sql`create table backup_status (
		id smallint primary key default 1 constraint backup_status_id_check check (id = 1),
		host jsonb,
		host_reported_at timestamptz,
		vm jsonb,
		vm_listed_at timestamptz
	)`.execute(db);
	await sql`insert into backup_status (id) values (1)`.execute(db);

	await sql`alter table workspaces add column pending_operation_args jsonb`.execute(db);
	await sql`alter table workspaces drop constraint workspaces_pending_operation_check`.execute(
		db,
	);
	await sql`alter table workspaces add constraint workspaces_pending_operation_check
		check (pending_operation in
			('reset-docker','rebuild','rebuild-reset-docker','replace-home'))`.execute(db);
	await sql`alter table recovery_points drop constraint recovery_points_reason_check`.execute(
		db,
	);
	await sql`alter table recovery_points add constraint recovery_points_reason_check
		check (reason in ('periodic','manual','before-archive','before-restore',
			'before-rebuild','agent-session','before-replace-home'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`delete from recovery_points where reason = 'before-replace-home'`.execute(
		db,
	);
	await sql`alter table recovery_points drop constraint recovery_points_reason_check`.execute(
		db,
	);
	await sql`alter table recovery_points add constraint recovery_points_reason_check
		check (reason in ('periodic','manual','before-archive','before-restore',
			'before-rebuild','agent-session'))`.execute(db);
	await sql`update workspaces set pending_operation = null
		where pending_operation = 'replace-home'`.execute(db);
	await sql`alter table workspaces drop constraint workspaces_pending_operation_check`.execute(
		db,
	);
	await sql`alter table workspaces add constraint workspaces_pending_operation_check
		check (pending_operation in
			('reset-docker','rebuild','rebuild-reset-docker'))`.execute(db);
	await sql`alter table workspaces drop column pending_operation_args`.execute(db);
	await sql`drop table backup_status`.execute(db);
	await sql`drop table backup_requests`.execute(db);
}
