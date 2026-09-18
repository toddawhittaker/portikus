/**
 * One file's diff, HEAD against the working tree (SPEC.md §12.6). There is
 * no polling: the filesystem event pipe invalidates this query when the file
 * changes, and coming back to the tab refetches it.
 */
import { GitDiff } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { fileKeys } from "./queries.js";

/** The URL of one file's diff. */
export function gitDiffUrl(
	workspaceId: string,
	projectId: string,
	path: string,
): string {
	const query = new URLSearchParams({ path });
	return `/workspaces/${workspaceId}/projects/${projectId}/git/diff?${query}`;
}

export function useGitDiff(workspaceId: string, projectId: string, path: string) {
	return useQuery({
		queryKey: fileKeys.diff(workspaceId, projectId, path),
		refetchOnWindowFocus: true,
		// Nothing polls a diff, so coming back to the window is one of the few
		// moments it can notice a change; a stale window would waste it.
		staleTime: 0,
		retry: false,
		queryFn: (): Promise<GitDiff> =>
			request(GitDiff, gitDiffUrl(workspaceId, projectId, path)),
	});
}
