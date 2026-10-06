import { z } from "zod";
import { MAX_GUARD_WINDOW_MINUTES } from "./guard.js";

/**
 * Workspace lifecycle states (SPEC.md §6.2, §18.3, §27). Only the worker
 * moves a row between them, through compare-and-set updates.
 */
export const WorkspaceState = z.enum([
	"provisioning",
	"starting",
	"running",
	"stopping",
	"stopped",
	"error",
]);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/**
 * The intent the API writes; the worker reads it to decide the next
 * transition (SPEC.md §27).
 */
export const DesiredState = z.enum(["running", "stopped", "restarting"]);
export type DesiredState = z.infer<typeof DesiredState>;

/**
 * The worker's error code for a failed stop. The sweep does not retry such
 * a stop on its own; a new Stop from the student clears it (SPEC.md §6.5).
 */
export const STOP_FAILED_ERROR_CODE = "STOP_FAILED";

/**
 * A maintenance operation the API asked for and the worker drives
 * (SPEC.md §16.4, §17.2; ADR 0021).
 */
export const PendingOperation = z.enum([
	"reset-docker",
	"rebuild",
	"rebuild-reset-docker",
	"replace-home",
]);
export type PendingOperation = z.infer<typeof PendingOperation>;

/** Request body for `POST /admin/workspaces/:id/rebuild` (SPEC.md §17.2). */
export const RebuildWorkspaceRequest = z
	.object({
		resetDocker: z.boolean(),
	})
	.strict();
export type RebuildWorkspaceRequest = z.infer<typeof RebuildWorkspaceRequest>;

/** A CPU or memory threshold, in percent of the workspace's limit (ADR 0032). */
export const GuardThresholdPercent = z.number().int().min(1).max(100);

/** The rolling window the guard averages over, in minutes. */
export const GuardWindowMinutes = z.number().int().min(5).max(MAX_GUARD_WINDOW_MINUTES);

/** The share of its CPU limit a throttled workspace keeps; 100 changes nothing. */
export const ThrottleSharePercent = z.number().int().min(5).max(100);

/** Minutes without activity before "Still working?"; 0 means never. */
export const IdleStopMinutes = z
	.number()
	.int()
	.refine((value) => value === 0 || (value >= 10 && value <= 1440), {
		message: "Must be 0 (never) or 10 to 1440 minutes",
	});

/** How many hours ahead a student may hold a workspace up; 0 turns holds off. */
export const KeepRunningMaxHours = z.number().int().min(0).max(168);

/** Body of `PUT /workspaces/:id/keep-running`: the hold ends at `until`. */
export const SetKeepRunningRequest = z
	.object({ until: z.string().datetime() })
	.strict();
export type SetKeepRunningRequest = z.infer<typeof SetKeepRunningRequest>;

/** Quiet minutes before a throttle lifts on its own. */
export const CpuIdleLiftMinutes = z.number().int().min(1).max(60);

/** CPU percent below which a throttled workspace counts as quiet; 0 turns lifting off. */
export const CpuIdleLiftPercent = z.number().int().min(0).max(100);

/** Throttles within the hold hours that make the latest survive a restart; 0 turns it off. */
export const CpuThrottleHoldAfter = z.number().int().min(0).max(10);

/** The window, in hours, the hold counts throttles over. */
export const CpuThrottleHoldHours = z.number().int().min(1).max(168);

/** Why a throttle is held: `count` throttles in the last `hours` hours (SPEC.md §19.4). */
export const CpuThrottleHeld = z.object({
	count: z.number().int().min(1),
	hours: CpuThrottleHoldHours,
});

/** The throttle numbers every view of `workspaces.cpu_throttle` shares. */
const CpuThrottleBase = z.object({
	at: z.string().datetime(),
	thresholdPercent: GuardThresholdPercent,
	windowMinutes: GuardWindowMinutes,
	sharePercent: ThrottleSharePercent,
	/** Present when a stop and start does not lift this throttle. */
	held: CpuThrottleHeld.optional(),
});

/**
 * What the student is told about a throttle: the numbers from the row, and
 * when it lifts on its own. Both lift fields are null when lifting is off.
 */
export const WorkspaceCpuThrottle = CpuThrottleBase.extend({
	idleLiftMinutes: CpuIdleLiftMinutes.nullable(),
	idleLiftPercent: CpuIdleLiftPercent.nullable(),
});
export type WorkspaceCpuThrottle = z.infer<typeof WorkspaceCpuThrottle>;

/** The whole `workspaces.cpu_throttle` row, as administrators see it. */
export const CpuThrottle = CpuThrottleBase.extend({
	/** The CPU average over the window that set the throttle, in percent. */
	averagePercent: z.number().nonnegative(),
	/** The `limits.cpu.allowance` the worker applies, such as `100ms/100ms`. */
	allowance: z.string().min(1),
});
export type CpuThrottle = z.infer<typeof CpuThrottle>;

/** The `workspaces.memory_flag` row; the owner and administrators see it. */
export const MemoryFlag = z.object({
	at: z.string().datetime(),
	averagePercent: z.number().nonnegative(),
	thresholdPercent: GuardThresholdPercent,
	windowMinutes: GuardWindowMinutes,
});
export type MemoryFlag = z.infer<typeof MemoryFlag>;

/** Workspace response body returned by the API (SPEC.md §26, §27). */
export const Workspace = z.object({
	id: z.string().uuid(),
	ownerUserId: z.string().uuid(),
	/** DNS label naming the container hostname and preview hosts. */
	label: z.string().min(1),
	state: WorkspaceState,
	desiredState: DesiredState,
	incusInstanceName: z.string().nullable(),
	imageVersion: z.string().nullable(),
	quotaConfig: z.object({
		homeGiB: z.number().int().positive(),
		dockerGiB: z.number().int().positive(),
		/** Absent on rows written before this field existed. */
		recoveryGiB: z.number().int().positive().optional(),
	}),
	/** Set while a Reset Docker or Rebuild is waiting or running. */
	pendingOperation: PendingOperation.nullable(),
	errorCode: z.string().nullable(),
	errorMessage: z.string().nullable(),
	activeConnections: z.number().int().nonnegative(),
	lastActiveConnectionAt: z.string().datetime().nullable(),
	shutdownDeadline: z.string().datetime().nullable(),
	/** Set when an administrator archived the workspace (SPEC.md §20.1). */
	archivedAt: z.string().datetime().nullable(),
	/** Set while the resource guard has slowed the workspace (ADR 0032). */
	cpuThrottle: WorkspaceCpuThrottle.nullable(),
	/** Set while memory use has been above the guard's threshold (ADR 0032). */
	memoryFlag: MemoryFlag.nullable(),
	/** When the workspace stops unless the student answers "Still working?". */
	idleStopAt: z.string().datetime().nullable(),
	/** The owner's last activity the API recorded. */
	lastActivityAt: z.string().datetime().nullable(),
	/** While set and ahead, grace and idle stop wait until then. */
	keepRunningUntil: z.string().datetime().nullable(),
	/** How far ahead a hold may reach for this workspace, in hours; 0 means off. */
	keepRunningMaxHours: KeepRunningMaxHours,
	/** False when the worker has not reached the controller lately, so state may be stale (SPEC.md §18.3). */
	stateVerified: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof Workspace>;

/** Longest a workspace label may be (SPEC.md section 14.3). */
export const MAX_WORKSPACE_LABEL_LENGTH = 40;

/**
 * Derive a workspace label from the identity provider's
 * `preferred_username` (SPEC.md section 14.3, BROWSER-HANDLING.md §8).
 * The label names the container hostname and every preview host, so it must
 * be a valid DNS label. `fallbackHex` (8 hex characters) is used when the
 * claim is missing or reduces to nothing.
 */
export function deriveWorkspaceLabel(
	preferredUsername: string | null | undefined,
	fallbackHex: string,
): string {
	const fallback = `ws-${fallbackHex}`;

	if (typeof preferredUsername !== "string") return fallback;

	const reduced = preferredUsername
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_WORKSPACE_LABEL_LENGTH)
		.replace(/-+$/g, "");

	if (reduced.length === 0) return fallback;

	// A label of digits only would be ambiguous with the port in a preview
	// host, and a leading digit is not a conventional DNS label either.
	const safe = /^[0-9]/.test(reduced)
		? `u${reduced}`.slice(0, MAX_WORKSPACE_LABEL_LENGTH)
		: reduced;

	return safe.replace(/-+$/g, "");
}

/**
 * Request body for `POST /workspaces` (SPEC.md §6.2). The owner comes from
 * the session, so the body carries nothing and must stay empty.
 */
export const CreateWorkspaceRequest = z.object({}).strict();
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/** Response body for `GET /admin/workspaces` (SPEC.md §5.2, §26). */
export const AdminWorkspaceList = z.object({
	workspaces: z.array(Workspace),
});
export type AdminWorkspaceList = z.infer<typeof AdminWorkspaceList>;

/** Error codes returned by the API (SPEC.md §27). */
export const ApiErrorCode = z.enum([
	"WORKSPACE_NOT_FOUND",
	"NOT_FOUND",
	"UNAUTHORIZED",
	"FORBIDDEN",
	"VALIDATION_FAILED",
	"CONTROLLER_UNAVAILABLE",
	"TOO_MANY_CONNECTIONS",
	"TERMINAL_LIMIT",
	"TERMINAL_NOT_FOUND",
	"PROJECT_EXISTS",
	"PROJECT_NOT_FOUND",
	"INVALID_SLUG",
	"INVALID_URL",
	"GIT_FAILED",
	"PATH_INVALID",
	"FILE_NOT_FOUND",
	"FILE_EXISTS",
	"FILE_CHANGED",
	"FILE_TOO_LARGE",
	"NOT_A_DIRECTORY",
	"ARCHIVE_INVALID",
	"SEARCH_FAILED",
	"WATCH_FAILED",
	"AGENT_UNAVAILABLE",
	// The preview routes (BROWSER-HANDLING.md §9.1).
	"WORKSPACE_NOT_RUNNING",
	"PREVIEW_PORT_NOT_ALLOWED",
	"PREVIEW_FORWARD_FAILED",
	"PREVIEW_RATE_LIMITED",
	// Stopping one process (SPEC.md §18.3).
	"STOP_IN_PROGRESS",
	"PROCESS_NOT_FOUND",
	"PROCESS_CHANGED",
	"PROCESS_PROTECTED",
	// Too many sign-in attempts from one address.
	"RATE_LIMITED",
	"CHECK_NOT_FOUND",
	"CHECK_RUNNING",
	"CHECK_NOT_RUNNING",
	"OPERATION_IN_PROGRESS",
	// Recovery and maintenance operations (SPEC.md §15, §16.4, §17.2).
	"STORAGE_FULL",
	"OPERATION_PENDING",
	"BUSY",
	"WORKSPACE_ARCHIVED",
	"NOT_IMPLEMENTED",
	// Dex user management (ADR 0028).
	"DEX_USER_EXISTS",
	"DEX_UNAVAILABLE",
	// One active invitation per email (SPEC.md section 24.13).
	"INVITATION_EXISTS",
	// Lift throttle or clear memory flag with nothing set (ADR 0032).
	"NOT_THROTTLED",
	"NOT_FLAGGED",
	// Re-provision of a workspace that is not in error (SPEC.md section 20.1).
	"NOT_IN_ERROR",
	// The local administrator and password change (SPEC.md section 5.3).
	"PASSWORD_CHANGE_REQUIRED",
	// The acceptable-use gate (SPEC.md section 5.1).
	"ACCEPTABLE_USE_REQUIRED",
	"ACCEPTABLE_USE_CHANGED",
	"NOT_LOCAL_PASSWORD",
	"WRONG_PASSWORD",
	// The second factor of Dex local passwords (SPEC.md section 24.13).
	"SECOND_FACTOR_REQUIRED",
	"WRONG_CODE",
	"LAST_SECOND_FACTOR",
	"WRONG_PASSKEY",
	"PASSKEY_EXPIRED",
	"NO_PASSKEY",
	// journalctl missing, failing or refused (docs/adr/0036).
	"LOGS_UNAVAILABLE",
	// Backups from the admin page (SPEC.md section 24.9, ADR 0024).
	"BACKUP_HOST_STALE",
	"BACKUP_RUNNING",
	"BACKUP_NEWEST_SET",
	"RESTORE_NOT_FINISHED",
	// The backup key on an apt-installed server (ADR 0044).
	"BACKUP_KEY_INVALID",
	"BACKUP_KEY_EXISTS",
	"BACKUP_KEY_UNAVAILABLE",
	// The database pool had no free connection in time (ADR 0034).
	"SERVICE_BUSY",
	// The workspace egress policy.
	"EGRESS_VERSION_STALE",
	"EGRESS_ENTRY_EXISTS",
	"EGRESS_LIMIT_REACHED",
	// The workspace image section (docs/SPEC.md section 22.4).
	"IMAGE_JOB_BUSY",
	"IMAGE_NOT_HEALTHY",
	"IMAGE_ALREADY_DEFAULT",
	"IMAGE_NO_PREVIOUS",
	// Delete refused for the default or previous image.
	"IMAGE_IN_USE",
	"CERTIFICATE_JOB_BUSY",
	"CERTIFICATE_NO_PREVIOUS",
	"CERTIFICATE_UPLOAD_REFUSED",
	"CERTIFICATE_PREFLIGHT_FAILED",
	"CERTIFICATE_SECRET_REQUIRED",
	// Notification settings (ADR 0052).
	"NOTIFY_JOB_BUSY",
	// Shared Docker pull storage.
	"SEED_JOB_RUNNING",
	"SEED_LIST_EMPTY",
	// Keep running until.
	"KEEP_RUNNING_OFF",
	"INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Standard error response body (SPEC.md §27). */
export const ApiError = z.object({
	code: ApiErrorCode,
	message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
