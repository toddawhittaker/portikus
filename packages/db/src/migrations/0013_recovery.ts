import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Compressed project copies kept on the recovery volume (SPEC.md §15,
	// ADR 0020). Deleting a project or workspace removes its rows.
	await db.schema
		.createTable("recovery_points")
		.addColumn("id", "uuid", (col) => col.primaryKey())
		.addColumn("project_id", "uuid", (col) =>
			col.notNull().references("projects.id").onDelete("cascade"),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("reason", "text", (col) =>
			col
				.notNull()
				.check(
					sql`reason IN ('periodic','manual','before-archive','before-restore','before-rebuild','agent-session')`,
				),
		)
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		// A user id, or "worker" for points the worker makes.
		.addColumn("created_by", "text", (col) => col.notNull())
		.addColumn("size_bytes", "bigint", (col) => col.notNull())
		.addColumn("sha256", "text", (col) => col.notNull())
		.addColumn("fingerprint", "text", (col) => col.notNull())
		.addColumn("expires_at", "timestamptz", (col) => col.notNull())
		.execute();
	await sql`CREATE INDEX recovery_points_project_created_idx ON recovery_points (project_id, created_at DESC)`.execute(
		db,
	);

	await db.schema
		.alterTable("projects")
		.addColumn("recovery_checked_at", "timestamptz")
		.execute();

	// Reset Docker and Rebuild, written by the API and driven by the worker
	// (SPEC.md §16.4, §17.2, ADR 0021).
	await db.schema
		.alterTable("workspaces")
		.addColumn("pending_operation", "text", (col) =>
			col.check(
				sql`pending_operation IN ('reset-docker','rebuild','rebuild-reset-docker')`,
			),
		)
		.execute();
	await db.schema
		.alterTable("workspaces")
		.addColumn("pending_operation_at", "timestamptz")
		.execute();
	await db.schema
		.alterTable("workspaces")
		.addColumn("pending_operation_by", "text")
		.execute();

	await db.schema
		.alterTable("terminals")
		.addColumn("recovery_point_id", "uuid", (col) =>
			col.references("recovery_points.id").onDelete("set null"),
		)
		.execute();

	await sql`UPDATE workspaces SET quota_config = quota_config || '{"recoveryGiB":3}'::jsonb WHERE quota_config IS NOT NULL AND NOT quota_config ? 'recoveryGiB'`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`UPDATE workspaces SET quota_config = quota_config - 'recoveryGiB' WHERE quota_config IS NOT NULL`.execute(
		db,
	);
	await db.schema.alterTable("terminals").dropColumn("recovery_point_id").execute();
	await db.schema.alterTable("workspaces").dropColumn("pending_operation_by").execute();
	await db.schema.alterTable("workspaces").dropColumn("pending_operation_at").execute();
	await db.schema.alterTable("workspaces").dropColumn("pending_operation").execute();
	await db.schema.alterTable("projects").dropColumn("recovery_checked_at").execute();
	await db.schema.dropTable("recovery_points").execute();
}
