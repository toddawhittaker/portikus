import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Each terminal carries its own colour scheme (issue #268). The per-user
	// setting only decides what a new terminal starts with, so the choice has
	// to live on the row to survive a reload and to be the same in every
	// browser. Terminals that already exist keep the old platform default.
	await db.schema
		.alterTable("terminals")
		.addColumn("theme", "text", (col) => col.notNull().defaultTo(sql`'dark'`))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("terminals").dropColumn("theme").execute();
}
