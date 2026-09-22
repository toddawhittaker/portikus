import type { ApiConfig } from "@portikus/config";
import type { AuthUser, Workspace } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";

/** Map a workspaces row to the Workspace contract shape. */
export function toWorkspace(
	row: Record<string, unknown>,
	activeConnections: number,
	config: ApiConfig,
): Workspace {
	const quota =
		typeof row.quota_config === "string"
			? JSON.parse(row.quota_config)
			: row.quota_config;
	return {
		id: row.id as string,
		ownerUserId: row.owner_user_id as string,
		label: row.label as string,
		state: row.state as Workspace["state"],
		desiredState: row.desired_state as Workspace["desiredState"],
		incusInstanceName: (row.incus_instance_name as string) ?? null,
		imageVersion: (row.image_version as string) ?? null,
		quotaConfig: quota ?? {
			homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
			dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
		},
		pendingOperation: (row.pending_operation as Workspace["pendingOperation"]) ?? null,
		errorCode: (row.error_code as string) ?? null,
		errorMessage: (row.error_message as string) ?? null,
		activeConnections,
		lastActiveConnectionAt: row.last_active_connection_at
			? (row.last_active_connection_at as Date).toISOString()
			: null,
		shutdownDeadline: row.shutdown_deadline
			? (row.shutdown_deadline as Date).toISOString()
			: null,
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
	};
}

/** Connections seen within the presence TTL (SPEC.md §6.4). */
export async function countActive(
	db: Kysely<Database>,
	workspaceId: string,
	config: ApiConfig,
): Promise<number> {
	const cutoff = new Date(
		Date.now() - config.PRESENCE_TTL_SECONDS * 1000,
	).toISOString();

	const result = await db
		.selectFrom("workspace_connections")
		.select(sql<number>`count(*)::int`.as("count"))
		.where("workspace_id", "=", workspaceId)
		.where("last_seen_at", ">", sql<Date>`${cutoff}::timestamptz`)
		.executeTakeFirstOrThrow();

	return result.count;
}

/**
 * Load a workspace the user is allowed to see. Students see only their own;
 * administrators see any. Returns null so callers answer 404 rather than
 * revealing that another student's workspace exists (SPEC.md §5.2, §24).
 */
export async function findOwnedWorkspace(
	db: Kysely<Database>,
	user: AuthUser,
	id: string,
): Promise<Record<string, unknown> | null> {
	let query = db.selectFrom("workspaces").selectAll().where("id", "=", id);
	if (user.role !== "administrator") {
		query = query.where("owner_user_id", "=", user.id);
	}
	const row = await query.executeTakeFirst();
	return (row as Record<string, unknown> | undefined) ?? null;
}

/**
 * Load a workspace only for its owner. Terminal routes use this instead of
 * findOwnedWorkspace: an administrator may see that a workspace exists, but
 * reading or typing into a student's terminal would be silent impersonation
 * (SPEC.md §20.2, §24).
 */
export async function findWorkspaceOwnedBy(
	db: Kysely<Database>,
	id: string,
	userId: string,
): Promise<Record<string, unknown> | null> {
	const row = await db
		.selectFrom("workspaces")
		.selectAll()
		.where("id", "=", id)
		.where("owner_user_id", "=", userId)
		.executeTakeFirst();
	return (row as Record<string, unknown> | undefined) ?? null;
}
