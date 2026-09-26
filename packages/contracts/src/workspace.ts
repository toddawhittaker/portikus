import { z } from "zod";

/**
 * Workspace lifecycle states (SPEC.md §6.2, §18.3, §27).
 *
 * Every workspace row is in exactly one of these states. Transitions are
 * driven by the worker process through compare-and-set updates.
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
 * A maintenance operation the API asked for and the worker drives
 * (SPEC.md §16.4, §17.2; ADR 0021).
 */
export const PendingOperation = z.enum([
	"reset-docker",
	"rebuild",
	"rebuild-reset-docker",
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
export const GuardWindowMinutes = z.number().int().min(5).max(240);

/** The share of its CPU limit a throttled workspace keeps; 100 changes nothing. */
export const ThrottleSharePercent = z.number().int().min(5).max(100);

/** Minutes without activity before "Still working?"; 0 means never. */
export const IdleStopMinutes = z
	.number()
	.int()
	.refine((value) => value === 0 || (value >= 10 && value <= 1440), {
		message: "Must be 0 (never) or 10 to 1440 minutes",
	});

/** What the student is told about a throttle: the numbers from the row. */
export const WorkspaceCpuThrottle = z.object({
	at: z.string().datetime(),
	thresholdPercent: GuardThresholdPercent,
	windowMinutes: GuardWindowMinutes,
	sharePercent: ThrottleSharePercent,
});
export type WorkspaceCpuThrottle = z.infer<typeof WorkspaceCpuThrottle>;

/** The whole `workspaces.cpu_throttle` row, as administrators see it. */
export const CpuThrottle = WorkspaceCpuThrottle.extend({
	/** The CPU average over the window that set the throttle, in percent. */
	averagePercent: z.number().nonnegative(),
	/** The `limits.cpu.allowance` the worker applies, such as `100ms/100ms`. */
	allowance: z.string().min(1),
});
export type CpuThrottle = z.infer<typeof CpuThrottle>;

/** The `workspaces.memory_flag` row; administrators only. */
export const MemoryFlag = z.object({
	at: z.string().datetime(),
	averagePercent: z.number().nonnegative(),
	thresholdPercent: GuardThresholdPercent,
	windowMinutes: GuardWindowMinutes,
});
export type MemoryFlag = z.infer<typeof MemoryFlag>;

/**
 * Workspace response body returned by the API (SPEC.md §26, §27).
 */
export const Workspace = z.object({
	id: z.string().uuid(),
	ownerUserId: z.string().uuid(),
	/** DNS label naming the container hostname and preview hosts (Epic 8). */
	label: z.string().min(1),
	state: WorkspaceState,
	desiredState: DesiredState,
	incusInstanceName: z.string().nullable(),
	imageVersion: z.string().nullable(),
	quotaConfig: z.object({
		homeGiB: z.number().int().positive(),
		dockerGiB: z.number().int().positive(),
		/** Absent on rows written before Epic 10. */
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
	/** When the workspace stops unless the student answers "Still working?". */
	idleStopAt: z.string().datetime().nullable(),
	/** The owner's last activity the API recorded. */
	lastActivityAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof Workspace>;

/** Longest a workspace label may be (SPEC.md Epic 8). */
export const MAX_WORKSPACE_LABEL_LENGTH = 40;

/**
 * Derive a workspace label from the identity provider's
 * `preferred_username` (SPEC.md Epic 8, BROWSER-HANDLING.md §8).
 *
 * The label names the container hostname and every preview host, so it must
 * be a valid DNS label: lowercase, only letters, digits, and single hyphens,
 * no leading or trailing hyphen, and at most 40 characters. A label that
 * would start with a digit gets a `u` in front, so `1234-5173.<suffix>` can
 * never be read as a port where a name belongs.
 *
 * `fallbackHex` is 8 hex characters the caller generates; it is used when
 * the claim is missing or reduces to nothing.
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

/**
 * Response body for `GET /admin/workspaces` (SPEC.md §5.2, §26).
 */
export const AdminWorkspaceList = z.object({
	workspaces: z.array(Workspace),
});
export type AdminWorkspaceList = z.infer<typeof AdminWorkspaceList>;

/**
 * Error codes returned by the API (SPEC.md §27).
 */
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
	"SEARCH_FAILED",
	"WATCH_FAILED",
	"AGENT_UNAVAILABLE",
	// The preview routes (BROWSER-HANDLING.md §9.1).
	"WORKSPACE_NOT_RUNNING",
	"PREVIEW_PORT_NOT_ALLOWED",
	"PREVIEW_FORWARD_FAILED",
	"PREVIEW_RATE_LIMITED",
	// Too many sign-in attempts from one address (#398).
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
	// Dex user management (docs/archive/epics/EPIC-14.md rulings 21 and 22).
	"DEX_USER_EXISTS",
	"DEX_UNAVAILABLE",
	// Lift throttle or clear memory flag with nothing set (ADR 0032).
	"NOT_THROTTLED",
	"NOT_FLAGGED",
	// The local administrator and password change (SPEC.md section 5.3).
	"PASSWORD_CHANGE_REQUIRED",
	// The acceptable-use gate (SPEC.md section 5.1).
	"ACCEPTABLE_USE_REQUIRED",
	"ACCEPTABLE_USE_CHANGED",
	"NOT_LOCAL_PASSWORD",
	"WRONG_PASSWORD",
	"INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * Standard error response body (SPEC.md §27).
 */
export const ApiError = z.object({
	code: ApiErrorCode,
	message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
