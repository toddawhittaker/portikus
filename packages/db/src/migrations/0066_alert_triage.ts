import { type Kysely, sql } from "kysely";

/**
 * A model's short explanation of an administrator alert (SPEC.md section
 * 20.4). The notification keeps the text and when it was written. Two
 * switches on the AI settings, both off until an administrator turns them
 * on: whether alerts are explained at all, and whether the explanation is
 * added to forwarded email and Pushover alerts. The daily limit counts
 * explanations, and their tokens are recorded under purpose `triage`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table notifications
		add column triage text check (char_length(triage) between 1 and 2000),
		add column triaged_at timestamptz`.execute(db);
	await sql`alter table ai_settings
		add column triage_enabled boolean not null default false,
		add column triage_daily_limit integer not null default 5
			check (triage_daily_limit between 0 and 100),
		add column triage_forward boolean not null default false`.execute(db);
	await sql`alter table ai_usage_days drop constraint ai_usage_days_purpose_check`.execute(
		db,
	);
	await sql`alter table ai_usage_days add constraint ai_usage_days_purpose_check
		check (purpose in ('assistant', 'pricing', 'triage'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`delete from ai_usage_days where purpose = 'triage'`.execute(db);
	await sql`alter table ai_usage_days drop constraint ai_usage_days_purpose_check`.execute(
		db,
	);
	await sql`alter table ai_usage_days add constraint ai_usage_days_purpose_check
		check (purpose in ('assistant', 'pricing'))`.execute(db);
	await sql`alter table ai_settings
		drop column triage_enabled,
		drop column triage_daily_limit,
		drop column triage_forward`.execute(db);
	await sql`alter table notifications
		drop column triage,
		drop column triaged_at`.execute(db);
}
