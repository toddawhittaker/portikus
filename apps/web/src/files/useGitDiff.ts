/**
 * One file's diff, HEAD against the working tree (SPEC.md §12.6). Nothing
 * polls: the project events socket invalidates this query when the file or
 * the repository changes, and coming back to the window or to the tab asks
 * again in case the socket was away.
 */
import { GitDiff } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { fileKeys } from "./queries.js";

/** The URL of one file's diff. */
function gitDiffUrl(workspaceId: string, projectId: string, path: string): string {
	const query = new URLSearchParams({ path });
	return `/workspaces/${workspaceId}/projects/${projectId}/git/diff?${query}`;
}

export function useGitDiff(workspaceId: string, projectId: string, path: string) {
	return useQuery({
		queryKey: fileKeys.diff(workspaceId, projectId, path),
		refetchOnWindowFocus: true,
		// Coming back to the window is another moment a diff can notice a
		// change; a stale window would waste it.
		staleTime: 0,
		retry: false,
		queryFn: (): Promise<GitDiff> =>
			request(GitDiff, gitDiffUrl(workspaceId, projectId, path)),
	});
}
