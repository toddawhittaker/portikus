import { type Kysely, sql } from "kysely";

/** Per-minute API response totals for the Health charts (docs/EPIC-19.md ruling 21). */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`create table api_request_samples (
		minute timestamptz primary key,
		requests int not null default 0,
		client_errors int not null default 0,
		server_errors int not null default 0,
		websocket_upgrades int not null default 0,
		latency_buckets int[] not null
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table api_request_samples`.execute(db);
}
