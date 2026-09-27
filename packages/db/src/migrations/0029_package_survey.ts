import { type Kysely, sql } from "kysely";

/**
 * The package survey's daily aggregates (SPEC.md §20.1, ADR 0042). No table
 * holds a workspace and a package name together: the only per-workspace
 * column is the date that workspace was last surveyed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table package_survey_days (
		day date primary key,
		surveyed int not null default 0
	)`.execute(db);
	await sql`create table package_survey_counts (
		day date not null references package_survey_days(day) on delete cascade,
		package text not null,
		workspaces int not null default 0,
		primary key (day, package)
	)`.execute(db);
	await sql`alter table workspaces add column package_surveyed_on date`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table workspaces drop column package_surveyed_on`.execute(db);
	await sql`drop table package_survey_counts`.execute(db);
	await sql`drop table package_survey_days`.execute(db);
}
