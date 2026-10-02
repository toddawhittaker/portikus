import type { FastifyReply } from "fastify";
import { sendError } from "../http.js";

/**
 * Workspaces with a long project operation (clone, template, duplicate,
 * download) running right now. Clone and copy hold a request open for
 * minutes, and two at once on one workspace race over the same directories.
 * This is per API process; the pilot runs exactly one (ADR 0010).
 */
const longOperations = new Set<string>();

/**
 * Claim the one long-operation slot for a workspace. Returns false after
 * answering 409, so the caller just returns.
 */
export function claimLongOperation(workspaceId: string, reply: FastifyReply): boolean {
	if (!holdLongOperation(workspaceId)) {
		sendError(
			reply,
			409,
			"OPERATION_IN_PROGRESS",
			"Another project operation is already running on this workspace.",
		);
		return false;
	}
	return true;
}

/** Claim the long-operation slot without answering; false when it is already held. */
export function holdLongOperation(workspaceId: string): boolean {
	if (longOperations.has(workspaceId)) return false;
	longOperations.add(workspaceId);
	return true;
}

/** Whether the workspace's long-operation slot is held right now. */
export function longOperationRunning(workspaceId: string): boolean {
	return longOperations.has(workspaceId);
}

/** Give the long-operation slot back. */
export function releaseLongOperation(workspaceId: string): void {
	longOperations.delete(workspaceId);
}
