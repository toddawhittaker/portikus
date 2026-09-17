import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// One row holds the platform-wide disconnect grace period (SPEC.md §6.4).
	// The worker seeds it from SHUTDOWN_GRACE_SECONDS on first start.
	await db.schema
		.createTable("settings")
		.addColumn("id", "smallint", (col) => col.primaryKey().check(sql`id = 1`))
		.addColumn("shutdown_grace_seconds", "integer", (col) =>
			col.notNull().check(sql`shutdown_grace_seconds >= 0`),
		)
		.addColumn("updated_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("updated_by", "uuid", (col) =>
			col.references("users.id").onDelete("set null"),
		)
		.execute();

	// Per-user override; null means use the global value.
	await db.schema
		.alterTable("users")
		.addColumn("shutdown_grace_seconds", "integer", (col) =>
			col.check(sql`shutdown_grace_seconds >= 0`),
		)
		.execute();

	await db.schema
		.alterTable("workspaces")
		.addColumn("disconnected_at", "timestamptz")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("workspaces").dropColumn("disconnected_at").execute();
	await db.schema.alterTable("users").dropColumn("shutdown_grace_seconds").execute();
	await db.schema.dropTable("settings").execute();
}
