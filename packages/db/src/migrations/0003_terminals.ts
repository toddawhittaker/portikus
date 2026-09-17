import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Per-workspace agent credentials. Not exposed on the public workspace
	// schema (SPEC.md §23.5).
	await db.schema.alterTable("workspaces").addColumn("agent_token", "text").execute();

	await db.schema.alterTable("workspaces").addColumn("agent_address", "text").execute();

	await db.schema
		.createTable("terminals")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("cwd", "text", (col) => col.notNull())
		.addColumn("position", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("ended_at", "timestamptz")
		.execute();

	await db.schema
		.createIndex("idx_terminals_workspace_ended")
		.on("terminals")
		.columns(["workspace_id", "ended_at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("terminals").execute();
	await db.schema.alterTable("workspaces").dropColumn("agent_address").execute();
	await db.schema.alterTable("workspaces").dropColumn("agent_token").execute();
}
