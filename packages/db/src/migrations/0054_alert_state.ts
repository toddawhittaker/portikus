import { type Kysely, sql } from "kysely";

/**
 * Whether each administrator alert is currently raised (SPEC.md sections
 * 24.4 and 24.13), so a worker restart does not announce it again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		add column alert_reboot_raised boolean not null default false,
		add column alert_signin_raised boolean not null default false,
		add column alert_root_fs_raised boolean not null default false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table settings
		drop column alert_reboot_raised,
		drop column alert_signin_raised,
		drop column alert_root_fs_raised`.execute(db);
}
