import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("users")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("oidc_issuer", "text", (col) => col.notNull())
		.addColumn("oidc_subject", "text", (col) => col.notNull())
		.addColumn("email", "text")
		.addColumn("display_name", "text", (col) => col.notNull())
		.addColumn("role", "text", (col) =>
			col.notNull().check(sql`role IN ('student','administrator')`),
		)
		.addColumn("disabled_at", "timestamptz")
		.addColumn("last_login_at", "timestamptz")
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("updated_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addUniqueConstraint("users_oidc_issuer_oidc_subject_key", [
			"oidc_issuer",
			"oidc_subject",
		])
		.execute();

	await db.schema
		.createTable("sessions")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("expires_at", "timestamptz", (col) => col.notNull())
		.execute();

	await db.schema
		.createIndex("idx_sessions_user")
		.on("sessions")
		.column("user_id")
		.execute();

	await db.schema
		.createIndex("idx_sessions_expires")
		.on("sessions")
		.column("expires_at")
		.execute();

	// Existing workspaces were created before login existed, so their owner
	// is free text that cannot be matched to a user row.
	await db.deleteFrom("workspaces" as never).execute();

	await sql`ALTER TABLE workspaces ALTER COLUMN owner_user_id TYPE uuid USING owner_user_id::uuid`.execute(
		db,
	);

	await db.schema
		.alterTable("workspaces")
		.addForeignKeyConstraint(
			"workspaces_owner_user_id_fkey",
			["owner_user_id"],
			"users",
			["id"],
		)
		.onDelete("restrict")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("workspaces")
		.dropConstraint("workspaces_owner_user_id_fkey")
		.execute();

	await sql`ALTER TABLE workspaces ALTER COLUMN owner_user_id TYPE text USING owner_user_id::text`.execute(
		db,
	);

	await db.schema.dropTable("sessions").execute();
	await db.schema.dropTable("users").execute();
}
