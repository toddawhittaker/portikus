import { type Database, recordAudit } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/**
 * Close a share past its end time. The one-open-share index still counts it
 * until `ended_at` is set (migration 0042).
 */
export async function closeExpired(
	db: Kysely<Database>,
	projectId: string,
): Promise<void> {
	await db
		.updateTable("project_shares")
		.set({ ended_at: sql<string>`ends_at` })
		.where("project_id", "=", projectId)
		.where("ended_at", "is", null)
		.where("ends_at", "<=", sql<Date>`now()`)
		.execute();
}

/**
 * End a project's live share, if it has one, and audit why: the owner
 * stopped it, or archived the project (SPEC.md §5.2, ADR 0057). A share that
 * already ran out ended on its own and is not audited again.
 */
export async function stopShare(
	db: Kysely<Database>,
	stop: { projectId: string; actor: string; reason: "stopped" | "archived" },
): Promise<void> {
	await closeExpired(db, stop.projectId);
	const stopped = await db
		.updateTable("project_shares")
		.set({ ended_at: sql<string>`now()` })
		.where("project_id", "=", stop.projectId)
		.where("ended_at", "is", null)
		.returning("id")
		.executeTakeFirst();
	if (!stopped) return;
	await recordAudit(db, {
		actor: stop.actor,
		target: stop.projectId,
		action: "project.share_stopped",
		result: "ok",
		metadata: { shareId: stopped.id, reason: stop.reason },
	});
}

/** When each of these projects' open, unexpired share ends, by project id. */
export async function sharedUntil(
	db: Kysely<Database>,
	projectIds: readonly string[],
): Promise<Map<string, string>> {
	if (projectIds.length === 0) return new Map();
	const rows = await db
		.selectFrom("project_shares")
		.select(["project_id", "ends_at"])
		.where("project_id", "in", projectIds)
		.where("ended_at", "is", null)
		.where("ends_at", ">", sql<Date>`now()`)
		.execute();
	return new Map(
		rows.map((row) => [row.project_id, new Date(row.ends_at).toISOString()]),
	);
}
