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
	"UNAUTHORIZED",
	"FORBIDDEN",
	"VALIDATION_FAILED",
	"CONTROLLER_UNAVAILABLE",
	"TOO_MANY_CONNECTIONS",
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
