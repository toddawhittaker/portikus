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
	}),
	errorCode: z.string().nullable(),
	errorMessage: z.string().nullable(),
	activeConnections: z.number().int().nonnegative(),
	lastActiveConnectionAt: z.string().datetime().nullable(),
	shutdownDeadline: z.string().datetime().nullable(),
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
	"CHECK_NOT_FOUND",
	"CHECK_RUNNING",
	"CHECK_NOT_RUNNING",
	"OPERATION_IN_PROGRESS",
	"NOT_IMPLEMENTED",
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
