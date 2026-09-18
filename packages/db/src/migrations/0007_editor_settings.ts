import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Per-user editor preferences (issue #159). Only the fields the user has
	// changed are stored; the API fills in the defaults for the rest.
	await db.schema
		.alterTable("users")
		.addColumn("editor_settings", "jsonb", (col) =>
			col.notNull().defaultTo(sql`'{}'::jsonb`),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("users").dropColumn("editor_settings").execute();
}
