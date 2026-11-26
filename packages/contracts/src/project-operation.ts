import { z } from "zod";
import { Project } from "./project.js";
import { ApiErrorCode } from "./workspace.js";

/**
 * A slow project request the API answers at once with 202 and then finishes
 * in the background, so no request waits past a proxy's response timeout
 * (SPEC.md §7.2, §7.3, §15.8).
 */
export const ProjectOperationKind = z.enum(["create", "duplicate", "restore"]);
export type ProjectOperationKind = z.infer<typeof ProjectOperationKind>;

export const ProjectOperationState = z.enum(["running", "succeeded", "failed"]);
export type ProjectOperationState = z.infer<typeof ProjectOperationState>;

export const ProjectOperation = z.object({
	id: z.string().uuid(),
	kind: ProjectOperationKind,
	state: ProjectOperationState,
	/** The project copied or restored; null for a new project. */
	projectId: z.string().uuid().nullable(),
	/** The recovery point being restored; null for the other kinds. */
	pointId: z.string().uuid().nullable(),
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	/** The project a create or duplicate made, once it succeeded. */
	project: Project.nullable(),
	/** The answer the request would have given before it became an operation. */
	error: z
		.object({
			status: z.number().int().min(400).max(599),
			code: ApiErrorCode,
			message: z.string(),
		})
		.nullable(),
});
export type ProjectOperation = z.infer<typeof ProjectOperation>;

/** Response body for `GET /workspaces/:id/project-operation`. */
export const CurrentProjectOperation = z.object({
	operation: ProjectOperation.nullable(),
});
export type CurrentProjectOperation = z.infer<typeof CurrentProjectOperation>;
