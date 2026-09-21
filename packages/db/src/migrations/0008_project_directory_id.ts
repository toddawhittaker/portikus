import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// The identity of the directory a project lives in, as the agent reports
	// it (issue #238). It lets a project renamed with `mv` in the shell be
	// reconnected to its row instead of becoming a new project. Null until the
	// next listing fills it in, and for a row whose workspace has never run.
	await db.schema.alterTable("projects").addColumn("directory_id", "text").execute();

	// Two rows must never claim the same directory. Null is not equal to null
	// in PostgreSQL, so rows without a directory id are unaffected.
	await db.schema
		.alterTable("projects")
		.addUniqueConstraint("projects_workspace_id_directory_id_key", [
			"workspace_id",
			"directory_id",
		])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("projects")
		.dropConstraint("projects_workspace_id_directory_id_key")
		.execute();
	await db.schema.alterTable("projects").dropColumn("directory_id").execute();
}
