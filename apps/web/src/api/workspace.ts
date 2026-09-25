import { Workspace } from "@portikus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "./request.js";

/**
 * `POST /workspaces` is idempotent: it returns the signed-in student's
 * workspace, creating it the first time. This is the only place the app
 * asks for it, so the sign-in redirect and the shell agree on the id.
 */
export function useEnsureWorkspace(enabled: boolean) {
	return useQuery({
		queryKey: ["workspace", "mine"],
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: ensureWorkspace,
	});
}

function ensureWorkspace() {
	return request(Workspace, "/workspaces", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
}

/**
 * The same call on a click, for an administrator, who gets a workspace only
 * when they open one (SPEC.md §6.1).
 */
export function useOpenWorkspace() {
	return useMutation({ mutationFn: ensureWorkspace });
}

/** What a student can ask the platform to do with their workspace (SPEC.md §6.2). */
export type WorkspaceAction = "start" | "stop" | "restart";

/**
 * Ask the API to move the workspace. The API only writes the desired state,
 * so this still works when the workspace agent inside the container is hung,
 * which is how a student recovers one (SPEC.md §6.2). The new state arrives
 * over the presence socket, so there is nothing to invalidate here.
 */
export function useWorkspaceAction(workspaceId: string) {
	return useMutation({
		mutationFn: (action: WorkspaceAction) =>
			request(z.unknown(), `/workspaces/${workspaceId}/${action}`, {
				method: "POST",
			}),
	});
}
