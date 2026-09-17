import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Runtime log level for every service; null means each one keeps its own
	// LOG_LEVEL from the environment (STACK.md §15).
	await db.schema
		.alterTable("settings")
		.addColumn("log_level", "text", (col) =>
			col.check(sql`log_level in ('error', 'warn', 'info', 'debug')`),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("settings").dropColumn("log_level").execute();
}
