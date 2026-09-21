import type { Kysely } from "kysely";

/**
 * A bootstrap ticket is presented on the preview host, where the main
 * Portikus session cookie is never sent. The preview session it creates must
 * still live with that main session (BROWSER-HANDLING.md §9.2), so the grant
 * carries the main session id from the moment it is issued.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("preview_grants")
		.addColumn("session_id", "text", (col) =>
			col.notNull().references("sessions.id").onDelete("cascade"),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("preview_grants").dropColumn("session_id").execute();
}
