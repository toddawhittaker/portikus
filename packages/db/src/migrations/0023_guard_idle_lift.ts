import { type Kysely, sql } from "kysely";

/** Automatic throttle lift after a quiet spell (ADR 0032, #596); percent 0 turns it off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column cpu_idle_lift_minutes int not null default 5
			constraint settings_cpu_idle_lift_minutes_check
			check (cpu_idle_lift_minutes between 1 and 60),
		add column cpu_idle_lift_percent int not null default 10
			constraint settings_cpu_idle_lift_percent_check
			check (cpu_idle_lift_percent between 0 and 100)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		drop column cpu_idle_lift_percent,
		drop column cpu_idle_lift_minutes`.execute(db);
}
