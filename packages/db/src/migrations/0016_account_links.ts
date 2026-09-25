import { type Kysely, sql } from "kysely";

/** Account links and the stored role grant (docs/archive/epics/EPIC-13-1.md, "The data model"). */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`alter table users add column provider_role text`.execute(db);
	await sql`update users set provider_role = role`.execute(db);
	await sql`alter table users alter column provider_role set not null`.execute(db);
	await sql`alter table users add constraint users_provider_role_check check (provider_role in ('student','instructor','administrator'))`.execute(
		db,
	);
	// Rows inserted naming only `role` (seeding scripts, test helpers) take it as their provider role.
	await sql`create function users_provider_role_default() returns trigger language plpgsql as $$
		begin
			if new.provider_role is null then new.provider_role := new.role; end if;
			return new;
		end $$`.execute(db);
	await sql`create trigger users_provider_role_default before insert on users
		for each row execute function users_provider_role_default()`.execute(db);

	await sql`alter table users add column granted_role text`.execute(db);
	await sql`alter table users add constraint users_granted_role_check check (granted_role in ('instructor','administrator'))`.execute(
		db,
	);
	await sql`alter table users add constraint users_granted_role_sso_check check (granted_role is null or oidc_issuer not like 'lti:%')`.execute(
		db,
	);

	await db.schema
		.createTable("account_links")
		.addColumn("course_user_id", "uuid", (col) =>
			col.primaryKey().references("users.id").onDelete("cascade"),
		)
		.addColumn("user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("platform_issuer", "text", (col) => col.notNull())
		.addColumn("archived_workspace", "boolean", (col) => col.notNull())
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addUniqueConstraint("account_links_user_platform_key", [
			"user_id",
			"platform_issuer",
		])
		.addCheckConstraint("account_links_distinct_check", sql`course_user_id <> user_id`)
		.execute();
	await db.schema
		.createIndex("account_links_user_id_idx")
		.on("account_links")
		.column("user_id")
		.execute();

	await db.schema
		.createTable("account_link_intents")
		.addColumn("state_hash", "text", (col) => col.primaryKey())
		.addColumn("session_id", "text", (col) =>
			col.notNull().unique().references("sessions.id").onDelete("cascade"),
		)
		.addColumn("course_user_id", "uuid", (col) =>
			col.notNull().references("users.id").onDelete("cascade"),
		)
		.addColumn("user_id", "uuid", (col) =>
			col.references("users.id").onDelete("cascade"),
		)
		.addColumn("expires_at", "timestamptz", (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex("account_link_intents_expires_at_idx")
		.on("account_link_intents")
		.column("expires_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("account_link_intents").execute();
	await db.schema.dropTable("account_links").execute();
	await sql`drop trigger users_provider_role_default on users`.execute(db);
	await sql`drop function users_provider_role_default()`.execute(db);
	await sql`alter table users drop column granted_role`.execute(db);
	await sql`alter table users drop column provider_role`.execute(db);
}
