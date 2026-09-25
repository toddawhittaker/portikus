import { type Kysely, sql } from "kysely";

/**
 * Resource guard and acceptable use (ADR 0032): platform settings, per-workspace
 * overrides and state, per-minute usage samples, and each user's accepted version.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column cpu_guard_threshold_percent int not null default 80
			constraint settings_cpu_guard_threshold_percent_check
			check (cpu_guard_threshold_percent between 1 and 100),
		add column memory_guard_threshold_percent int not null default 90
			constraint settings_memory_guard_threshold_percent_check
			check (memory_guard_threshold_percent between 1 and 100),
		add column guard_window_minutes int not null default 30
			constraint settings_guard_window_minutes_check
			check (guard_window_minutes between 5 and 240),
		add column cpu_throttle_share_percent int not null default 25
			constraint settings_cpu_throttle_share_percent_check
			check (cpu_throttle_share_percent between 5 and 100),
		add column idle_stop_minutes int not null default 60
			constraint settings_idle_stop_minutes_check
			check (idle_stop_minutes = 0 or idle_stop_minutes between 10 and 1440),
		add column acceptable_use_text text,
		add column acceptable_use_version int not null default 1`.execute(db);

	await sql`alter table workspaces
		add column guard_config jsonb,
		add column cpu_throttle jsonb,
		add column memory_flag jsonb,
		add column last_activity_at timestamptz,
		add column idle_stop_at timestamptz`.execute(db);

	await sql`alter table users
		add column acceptable_use_version int,
		add column acceptable_use_accepted_at timestamptz`.execute(db);

	await backfillIdleOverride(db);
	// A workspace not stopped counts as active now, so idle stop never fires at once,
	// including one that was stopping at deploy and returns to running.
	await sql`update workspaces set last_activity_at = now()
		where last_activity_at is null and state <> 'stopped'`.execute(db);

	await sql`create table workspace_usage_samples (
		id bigserial primary key,
		workspace_id uuid not null references workspaces(id) on delete cascade,
		observed_at timestamptz not null,
		cpu_usage_ns bigint not null,
		boot_marker bigint,
		cpu_limit int not null,
		memory_bytes bigint not null,
		memory_limit_bytes bigint not null
	)`.execute(db);
	await sql`create index workspace_usage_samples_workspace_observed_idx
		on workspace_usage_samples (workspace_id, observed_at)`.execute(db);
}

/** Owners who opted out of the grace period keep running as before; exported for its test. */
export async function backfillIdleOverride(db: Kysely<unknown>): Promise<void> {
	await sql`update workspaces w
		set guard_config = coalesce(w.guard_config, '{}'::jsonb) || '{"idleStopMinutes": 0}'::jsonb
		from users u
		where u.id = w.owner_user_id and u.shutdown_grace_seconds = 0`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table workspace_usage_samples`.execute(db);
	await sql`alter table users
		drop column acceptable_use_accepted_at,
		drop column acceptable_use_version`.execute(db);
	await sql`alter table workspaces
		drop column idle_stop_at,
		drop column last_activity_at,
		drop column memory_flag,
		drop column cpu_throttle,
		drop column guard_config`.execute(db);
	await sql`alter table settings
		drop column acceptable_use_version,
		drop column acceptable_use_text,
		drop column idle_stop_minutes,
		drop column cpu_throttle_share_percent,
		drop column guard_window_minutes,
		drop column memory_guard_threshold_percent,
		drop column cpu_guard_threshold_percent`.execute(db);
}
