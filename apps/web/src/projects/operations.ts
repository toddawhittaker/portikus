/**
 * Clone, duplicate and restore answer 202 at once and finish on the server,
 * so no request outlasts a proxy's response timeout (SPEC.md §7.2, §7.3,
 * §15.8). These helpers follow an operation to its end and answer as the
 * request used to: the new project, nothing for a restore, or the same error.
 */
import {
	CurrentProjectOperation,
	Project,
	ProjectOperation,
} from "@portikus/contracts";
import { ApiError, request, toApiError } from "../api/request.js";

/** How often a running operation is read again. */
export const OPERATION_POLL_MS = 1000;

/** Shown when the server no longer knows the operation, as after a restart. */
export const LOST_OPERATION_MESSAGE =
	"Portikus lost track of this request, which can happen when the server restarts. Check the projects list to see whether it finished, then try again if it did not.";

export const operationUrl = (workspaceId: string) =>
	`/workspaces/${workspaceId}/project-operation`;

/** The workspace's current or most recent operation, or null. */
export async function readOperation(
	workspaceId: string,
): Promise<ProjectOperation | null> {
	const body = await request(CurrentProjectOperation, operationUrl(workspaceId));
	return body.operation;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `operation` to finish; a failure throws the error the request used to. */
export async function followOperation(
	workspaceId: string,
	operation: ProjectOperation,
): Promise<ProjectOperation> {
	let current = operation;
	while (current.state === "running") {
		await sleep(OPERATION_POLL_MS);
		const read = await readOperation(workspaceId);
		if (read?.id !== operation.id) throw new ApiError(410, LOST_OPERATION_MESSAGE);
		current = read;
	}
	if (current.error) {
		throw new ApiError(current.error.status, current.error.message, current.error.code);
	}
	return current;
}

/**
 * POST `body` to `url` and follow the operation a 202 starts. A route that
 * answered at once (a new empty project) is read as before.
 */
export async function postOperation(
	workspaceId: string,
	url: string,
	body: unknown,
): Promise<Project | undefined> {
	const response = await fetch(url, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw await toApiError(response);
	if (response.status === 204) return undefined;
	if (response.status !== 202) return Project.parse(await response.json());
	const started = ProjectOperation.parse(await response.json());
	try {
		const done = await followOperation(workspaceId, started);
		return done.project ?? undefined;
	} finally {
		// This page shows the outcome itself; a later reload need not.
		markOperationHandled(started.id);
	}
}

const HANDLED_KEY = "portikus.handled-project-operation";

/** Remember that this tab has shown `id`'s outcome, so a reload does not show it twice. */
export function markOperationHandled(id: string): void {
	try {
		sessionStorage.setItem(HANDLED_KEY, id);
	} catch {
		// Without storage a reload may show the outcome once more; nothing breaks.
	}
}

export function isOperationHandled(id: string): boolean {
	try {
		return sessionStorage.getItem(HANDLED_KEY) === id;
	} catch {
		return false;
	}
}
