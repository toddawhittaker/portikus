import { type Kysely, sql } from "kysely";

/** A terminal row is a shell tab or a chat tab (SPEC.md §10.8); existing rows are shells. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table terminals
			add column kind text not null default 'terminal'
			constraint terminals_kind_check check (kind in ('terminal', 'chat'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table terminals drop column kind`.execute(db);
}
