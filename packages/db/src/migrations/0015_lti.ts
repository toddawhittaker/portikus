import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// The first role between student and administrator (SPEC.md §5.2, Epic 13).
	await sql`alter table users drop constraint users_role_check`.execute(db);
	await sql`alter table users add constraint users_role_check check (role in ('student','instructor','administrator'))`.execute(
		db,
	);

	// One row per third-party login, consumed by the launch; only the state's hash is kept.
	await db.schema
		.createTable("lti_login_states")
		.addColumn("state_hash", "text", (col) => col.primaryKey())
		.addColumn("nonce", "text", (col) => col.notNull())
		.addColumn("platform_issuer", "text", (col) => col.notNull())
		.addColumn("client_id", "text", (col) => col.notNull())
		.addColumn("expires_at", "timestamptz", (col) => col.notNull())
		.execute();
	// Every save deletes expired rows first; keep that delete off a full scan.
	await db.schema
		.createIndex("lti_login_states_expires_at_idx")
		.on("lti_login_states")
		.column("expires_at")
		.execute();

	await db.schema
		.createTable("lti_contexts")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("platform_issuer", "text", (col) => col.notNull())
		.addColumn("context_id", "text", (col) => col.notNull())
		.addColumn("title", "text", (col) => col.notNull().defaultTo(""))
		.addColumn("platform_name", "text", (col) => col.notNull())
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addColumn("updated_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addUniqueConstraint("lti_contexts_platform_context_key", [
			"platform_issuer",
			"context_id",
		])
		.execute();

	await db.schema
		.createTable("lti_memberships")
		.addColumn("context_id", "uuid", (col) =>
			col.notNull().references("lti_contexts.id").onDelete("cascade"),
		)
		.addColumn("user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("role", "text", (col) =>
			col.notNull().check(sql`role in ('student','instructor')`),
		)
		.addColumn("last_launch_at", "timestamptz", (col) => col.notNull())
		.addPrimaryKeyConstraint("lti_memberships_pkey", ["context_id", "user_id"])
		.execute();
	await db.schema
		.createIndex("lti_memberships_user_id_idx")
		.on("lti_memberships")
		.column("user_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("lti_memberships").execute();
	await db.schema.dropTable("lti_contexts").execute();
	await db.schema.dropTable("lti_login_states").execute();
	// Instructors fall back to students so the narrower check can be restored.
	await sql`update users set role = 'student' where role = 'instructor'`.execute(db);
	await sql`alter table users drop constraint users_role_check`.execute(db);
	await sql`alter table users add constraint users_role_check check (role in ('student','administrator'))`.execute(
		db,
	);
}
