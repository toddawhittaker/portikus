import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Browser presence for a workspace (SPEC.md §6.4). Both the workspace socket
 * and a terminal attachment register here, so a terminal alone keeps the
 * workspace running and cancels the shutdown timer.
 */
export async function openPresence(
	db: Kysely<Database>,
	workspaceId: string,
	connectionId: string,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.insertInto("workspace_connections")
		.values({ id: connectionId, workspace_id: workspaceId })
		.execute();

	await db
		.updateTable("workspaces")
		.set({
			desired_state: "running",
			last_active_connection_at: now,
			updated_at: now,
		})
		.where("id", "=", workspaceId)
		.execute();
}

/** Remove one presence row when its socket goes away. */
export async function dropPresence(
	db: Kysely<Database>,
	connectionId: string,
): Promise<void> {
	await db.deleteFrom("workspace_connections").where("id", "=", connectionId).execute();
}

/** Keep a presence row fresh while its socket stays open. */
export async function touchPresence(
	db: Kysely<Database>,
	connectionId: string,
): Promise<void> {
	await db
		.updateTable("workspace_connections")
		.set({ last_seen_at: new Date().toISOString() })
		.where("id", "=", connectionId)
		.execute();
}
