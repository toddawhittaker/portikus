import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// The optional profile a student fills in (issue #300). None of it is
	// used for authorization. The picture is small and capped by the API.
	await db.schema.alterTable("users").addColumn("profile_github", "text").execute();
	await db.schema.alterTable("users").addColumn("profile_website", "text").execute();
	await db.schema.alterTable("users").addColumn("picture", "bytea").execute();
	await db.schema.alterTable("users").addColumn("picture_type", "text").execute();
	await db.schema
		.alterTable("users")
		.addColumn("picture_updated_at", "timestamptz")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("users").dropColumn("picture_updated_at").execute();
	await db.schema.alterTable("users").dropColumn("picture_type").execute();
	await db.schema.alterTable("users").dropColumn("picture").execute();
	await db.schema.alterTable("users").dropColumn("profile_website").execute();
	await db.schema.alterTable("users").dropColumn("profile_github").execute();
}
