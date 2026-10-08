import { type ApiConfig, STATE_VERIFIED_WITHIN_MS } from "@portikus/config";
import {
	type AuthUser,
	DEFAULT_KEEP_RUNNING_MAX_HOURS,
	type GuardConfig,
	idleLift,
	keepRunningMaxHours,
	type QuotaConfig,
	type Workspace,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, type Selectable, sql } from "kysely";

/** Parse a jsonb value that may arrive as text. */
export function fromJson<T>(value: unknown): T | null {
	if (value === null || value === undefined) return null;
	return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/**
 * The throttle numbers the student is shown, never the allowance string,
 * with when it lifts on its own from the settings row.
 */
function toStudentThrottle(
	value: unknown,
	lift: { minutes: number; percent: number } | null,
): Workspace["cpuThrottle"] {
	const raw = fromJson<NonNullable<Workspace["cpuThrottle"]>>(value);
	if (!raw) return null;
	return {
		at: raw.at,
		thresholdPercent: raw.thresholdPercent,
		windowMinutes: raw.windowMinutes,
		sharePercent: raw.sharePercent,
		...(raw.held ? { held: { count: raw.held.count, hours: raw.held.hours } } : {}),
		idleLiftMinutes: lift?.minutes ?? null,
		// The worker lifts under half the share too; whole percents, rounded down.
		idleLiftPercent: lift
			? Math.min(lift.percent, Math.floor(raw.sharePercent / 2))
			: null,
	};
}

/** The memory flag's numbers (ADR 0032). */
function toMemoryFlag(value: unknown): Workspace["memoryFlag"] {
	const raw = fromJson<NonNullable<Workspace["memoryFlag"]>>(value);
	if (!raw) return null;
	return {
		at: raw.at,
		averagePercent: raw.averagePercent,
		thresholdPercent: raw.thresholdPercent,
		windowMinutes: raw.windowMinutes,
	};
}

export type WorkspaceRow = Selectable<Database["workspaces"]>;

/** The settings columns a Workspace view needs: when a throttle lifts, the cap on a hold, and when the controller last answered. */
export type WorkspaceSettings = Pick<
	Selectable<Database["settings"]>,
	| "cpu_idle_lift_minutes"
	| "cpu_idle_lift_percent"
	| "keep_running_max_hours"
	| "controller_checked_at"
>;

/** Read the settings row once per request; undefined before the first one exists. */
export async function loadWorkspaceSettings(
	db: Kysely<Database>,
): Promise<WorkspaceSettings | undefined> {
	return db
		.selectFrom("settings")
		.select([
			"cpu_idle_lift_minutes",
			"cpu_idle_lift_percent",
			"keep_running_max_hours",
			"controller_checked_at",
		])
		.where("id", "=", 1)
		.executeTakeFirst();
}

function iso(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

/** Map a workspaces row to the Workspace contract shape. */
export function toWorkspace(
	row: WorkspaceRow,
	activeConnections: number,
	config: ApiConfig,
	settings: WorkspaceSettings | undefined,
	now: Date = new Date(),
): Workspace {
	const checked = settings?.controller_checked_at ?? null;
	const age = checked === null ? null : now.getTime() - checked.getTime();
	// A check in the future means the clock was stepped back, so it proves nothing.
	const stateVerified = age !== null && age >= 0 && age <= STATE_VERIFIED_WITHIN_MS;
	const lift = row.cpu_throttle && settings ? idleLift(settings) : null;
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		label: row.label,
		state: row.state,
		desiredState: row.desired_state,
		incusInstanceName: row.incus_instance_name,
		imageVersion: row.image_version,
		quotaConfig: fromJson<QuotaConfig>(row.quota_config) ?? {
			homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
			dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
			recoveryGiB: config.WORKSPACE_RECOVERY_SIZE_GIB,
		},
		pendingOperation: row.pending_operation,
		errorCode: row.error_code,
		errorMessage: row.error_message,
		activeConnections,
		lastActiveConnectionAt: iso(row.last_active_connection_at),
		shutdownDeadline: iso(row.shutdown_deadline),
		archivedAt: iso(row.archived_at),
		cpuThrottle: toStudentThrottle(row.cpu_throttle, lift),
		memoryFlag: toMemoryFlag(row.memory_flag),
		idleStopAt: iso(row.idle_stop_at),
		lastActivityAt: iso(row.last_activity_at),
		keepRunningUntil: iso(row.keep_running_until),
		// No settings row yet means nothing has capped holds; use the column default.
		keepRunningMaxHours: keepRunningMaxHours(
			settings?.keep_running_max_hours ?? DEFAULT_KEEP_RUNNING_MAX_HOURS,
			fromJson<GuardConfig>(row.guard_config),
		),
		stateVerified,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
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
): Promise<WorkspaceRow | null> {
	let query = db.selectFrom("workspaces").selectAll().where("id", "=", id);
	if (user.role !== "administrator") {
		query = query.where("owner_user_id", "=", user.id);
	}
	return (await query.executeTakeFirst()) ?? null;
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
): Promise<WorkspaceRow | null> {
	const row = await db
		.selectFrom("workspaces")
		.selectAll()
		.where("id", "=", id)
		.where("owner_user_id", "=", userId)
		.executeTakeFirst();
	return row ?? null;
}

/** Connections seen within the presence TTL, per workspace, in one query (SPEC.md §6.4). */
export async function countActiveByWorkspace(
	db: Kysely<Database>,
	config: ApiConfig,
): Promise<Map<string, number>> {
	const cutoff = new Date(Date.now() - config.PRESENCE_TTL_SECONDS * 1000);
	const counts = await db
		.selectFrom("workspace_connections")
		.select(["workspace_id", sql<number>`count(*)::int`.as("count")])
		.where("last_seen_at", ">", sql<Date>`${cutoff.toISOString()}::timestamptz`)
		.groupBy("workspace_id")
		.execute();
	return new Map(counts.map((row) => [row.workspace_id, row.count]));
}

/** One workspace as the Workspace contract shows it. */
export async function workspaceView(
	db: Kysely<Database>,
	config: ApiConfig,
	row: WorkspaceRow,
): Promise<Workspace> {
	const active = await countActive(db, row.id, config);
	return toWorkspace(row, active, config, await loadWorkspaceSettings(db));
}

/** Many workspaces as Workspace views, with one settings read and one count query. */
export async function workspaceViews(
	db: Kysely<Database>,
	config: ApiConfig,
	rows: WorkspaceRow[],
): Promise<Workspace[]> {
	const settings = await loadWorkspaceSettings(db);
	const active = await countActiveByWorkspace(db, config);
	return rows.map((row) => toWorkspace(row, active.get(row.id) ?? 0, config, settings));
}
