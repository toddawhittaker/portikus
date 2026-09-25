import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/** The API writes a workspace's activity at most this often. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

/** When each workspace's activity was last written, per database handle. */
const lastWrites = new WeakMap<Kysely<Database>, Map<string, number>>();

/**
 * Record that a workspace's owner did something on purpose: a key press in
 * the page, a file write, or a preview page load. It sets `last_activity_at`
 * and clears a pending "Still working?" in one statement, at most once a
 * minute per workspace. Callers check that the actor is the owner; an
 * administrator's visit never counts.
 */
export async function recordActivity(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<void> {
	let written = lastWrites.get(db);
	if (!written) {
		written = new Map();
		lastWrites.set(db, written);
	}
	const now = Date.now();
	const last = written.get(workspaceId);
	if (last !== undefined && now - last < ACTIVITY_WRITE_INTERVAL_MS) return;
	// Claimed before the write so two requests at once make one write.
	written.set(workspaceId, now);
	try {
		await db
			.updateTable("workspaces")
			.set({ last_activity_at: new Date(now).toISOString(), idle_stop_at: null })
			.where("id", "=", workspaceId)
			.execute();
	} catch (error) {
		written.delete(workspaceId);
		throw error;
	}
}
