import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("workspaces")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("owner_user_id", "text", (col) => col.notNull().unique())
		.addColumn("incus_instance_name", "text", (col) => col.unique())
		.addColumn("state", "text", (col) =>
			col
				.notNull()
				.defaultTo("provisioning")
				.check(
					sql`state IN ('provisioning','starting','running','stopping','stopped','error')`,
				),
		)
		.addColumn("desired_state", "text", (col) =>
			col
				.notNull()
				.defaultTo("stopped")
				.check(sql`desired_state IN ('running','stopped','restarting')`),
		)
		.addColumn("image_version", "text")
		.addColumn("quota_config", "jsonb")
		.addColumn("error_code", "text")
		.addColumn("error_message", "text")
		.addColumn("last_active_connection_at", "timestamptz")
		.addColumn("shutdown_deadline", "timestamptz")
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("updated_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.execute();

	await db.schema
		.createTable("workspace_connections")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("connected_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("last_seen_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.execute();

	await db.schema
		.createIndex("idx_workspace_connections_ws_seen")
		.on("workspace_connections")
		.columns(["workspace_id", "last_seen_at"])
		.execute();

	await db.schema
		.createTable("audit_events")
		.addColumn("id", "bigserial", (col) => col.primaryKey())
		.addColumn("actor", "text", (col) => col.notNull())
		.addColumn("target", "text", (col) => col.notNull())
		.addColumn("action", "text", (col) => col.notNull())
		.addColumn("at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
		.addColumn("result", "text", (col) => col.notNull())
		.addColumn("metadata", "jsonb")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("audit_events").execute();
	await db.schema.dropTable("workspace_connections").execute();
	await db.schema.dropTable("workspaces").execute();
}
