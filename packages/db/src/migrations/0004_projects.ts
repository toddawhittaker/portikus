import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Projects mirror the directories under ~/projects (SPEC.md §7.1, §26).
	await db.schema
		.createTable("projects")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("slug", "text", (col) => col.notNull())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("path", "text", (col) => col.notNull())
		.addColumn("state", "text", (col) =>
			col.notNull().defaultTo("active").check(sql`state IN ('active','archived')`),
		)
		.addColumn("source", "text", (col) =>
			col.notNull().check(sql`source IN ('new','clone','template','discovered')`),
		)
		.addColumn("layout", "jsonb")
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("archived_at", "timestamptz")
		.addUniqueConstraint("projects_workspace_id_slug_key", ["workspace_id", "slug"])
		.execute();

	await db.schema
		.alterTable("terminals")
		.addColumn("project_id", "uuid", (col) =>
			col.references("projects.id").onDelete("set null"),
		)
		.execute();

	await db.schema
		.createIndex("idx_terminals_project")
		.on("terminals")
		.column("project_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_terminals_project").execute();
	await db.schema.alterTable("terminals").dropColumn("project_id").execute();
	await db.schema.dropTable("projects").execute();
}
