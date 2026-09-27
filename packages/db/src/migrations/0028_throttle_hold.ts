import { type Kysely, sql } from "kysely";

/** A throttle that survives a restart after repeated throttles (SPEC.md §19.4); 0 turns it off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column cpu_throttle_hold_after int not null default 3
			constraint settings_cpu_throttle_hold_after_check
			check (cpu_throttle_hold_after between 0 and 10),
		add column cpu_throttle_hold_hours int not null default 24
			constraint settings_cpu_throttle_hold_hours_check
			check (cpu_throttle_hold_hours between 1 and 168)`.execute(db);
	await sql`alter table workspaces
		add column cpu_throttle_recent timestamptz[] not null default '{}'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table workspaces drop column cpu_throttle_recent`.execute(db);
	await sql`alter table settings
		drop column cpu_throttle_hold_hours,
		drop column cpu_throttle_hold_after`.execute(db);
}
