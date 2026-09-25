import { type Kysely, sql } from "kysely";

/** Each user's notification history: one row per toast shown (ADR 0033). */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table notifications (
		id uuid primary key default gen_random_uuid(),
		user_id uuid not null references users(id) on delete cascade,
		tone text not null
			constraint notifications_tone_check
			check (tone in ('neutral', 'success', 'warning', 'danger')),
		title text not null,
		body text not null default '',
		created_at timestamptz not null default now(),
		read_at timestamptz
	)`.execute(db);
	await sql`create index notifications_user_created_idx
		on notifications (user_id, created_at desc)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table notifications`.execute(db);
}
