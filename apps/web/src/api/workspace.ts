import { Workspace } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
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
		queryFn: () =>
			request(Workspace, "/workspaces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
	});
}
