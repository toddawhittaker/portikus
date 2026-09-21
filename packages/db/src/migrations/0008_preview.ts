import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// The login username the workspace label is derived from (SPEC.md Epic 8).
	// Nullable: not every identity provider sends `preferred_username`.
	await db.schema.alterTable("users").addColumn("preferred_username", "text").execute();

	// The workspace label names the container hostname and every preview
	// host (BROWSER-HANDLING.md section 8).
	await db.schema.alterTable("workspaces").addColumn("label", "text").execute();

	// Existing rows predate the label, and their owners' usernames were never
	// stored, so they get the same `ws-<8 hex>` fallback a missing claim gets.
	await sql`UPDATE workspaces SET label = 'ws-' || substr(md5(id::text), 1, 8) WHERE label IS NULL`.execute(
		db,
	);

	await db.schema
		.alterTable("workspaces")
		.alterColumn("label", (col) => col.setNotNull())
		.execute();

	await db.schema
		.createIndex("idx_workspaces_label")
		.unique()
		.on("workspaces")
		.column("label")
		.execute();

	// Single-use bootstrap tickets (BROWSER-HANDLING.md sections 9.1, 17).
	await db.schema
		.createTable("preview_grants")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("port", "integer", (col) => col.notNull())
		.addColumn("preview_host", "text", (col) => col.notNull())
		.addColumn("presentation", "text", (col) =>
			col.notNull().check(sql`presentation IN ('embedded','top-level')`),
		)
		// A ticket is presented on the preview host, where the main Portikus
		// session cookie is never sent. The preview session it creates must
		// still live with that main session (BROWSER-HANDLING.md 9.2), so the
		// grant carries the main session id from the moment it is issued.
		.addColumn("session_id", "text", (col) =>
			col.notNull().references("sessions.id").onDelete("cascade"),
		)
		.addColumn("ticket_hash", "text", (col) => col.notNull())
		.addColumn("expires_at", "timestamptz", (col) => col.notNull())
		.addColumn("consumed_at", "timestamptz")
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.execute();

	await db.schema
		.createIndex("idx_preview_grants_ticket_hash")
		.unique()
		.on("preview_grants")
		.column("ticket_hash")
		.execute();

	await db.schema
		.createIndex("idx_preview_grants_workspace")
		.on("preview_grants")
		.column("workspace_id")
		.execute();

	// Preview-host sessions, which live and die with the main Portikus
	// session that created them (BROWSER-HANDLING.md sections 9.2, 17).
	await db.schema
		.createTable("preview_sessions")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("token_hash", "text", (col) => col.notNull())
		.addColumn("user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("session_id", "text", (col) =>
			col.notNull().references("sessions.id").onDelete("cascade"),
		)
		.addColumn("workspace_id", "uuid", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("port", "integer", (col) => col.notNull())
		.addColumn("preview_host", "text", (col) => col.notNull())
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("revoked_at", "timestamptz")
		.execute();

	await db.schema
		.createIndex("idx_preview_sessions_token_hash")
		.unique()
		.on("preview_sessions")
		.column("token_hash")
		.execute();

	await db.schema
		.createIndex("idx_preview_sessions_workspace")
		.on("preview_sessions")
		.column("workspace_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("preview_sessions").execute();
	await db.schema.dropTable("preview_grants").execute();
	await db.schema.dropIndex("idx_workspaces_label").execute();
	await db.schema.alterTable("workspaces").dropColumn("label").execute();
	await db.schema.alterTable("users").dropColumn("preferred_username").execute();
}
