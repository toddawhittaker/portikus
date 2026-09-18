/**
 * One file's diff, HEAD against the working tree (SPEC.md §12.6). Polled
 * while its tab is visible, because nothing invalidates this query from the
 * outside yet: the project events consumer that will push a change arrives in
 * task 11 of this epic. Until then polling, coming back to the window, and a
 * save of the same path are how a change is noticed.
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

export function useGitDiff(
	workspaceId: string,
	projectId: string,
	path: string,
	visible = true,
) {
	return useQuery({
		queryKey: fileKeys.diff(workspaceId, projectId, path),
		// Until the project events consumer lands (task 11), this poll is what
		// notices a change an agent or a shell made.
		refetchInterval: visible ? 5000 : false,
		refetchOnWindowFocus: true,
		// Coming back to the window is another moment a diff can notice a
		// change; a stale window would waste it.
		staleTime: 0,
		retry: false,
		queryFn: (): Promise<GitDiff> =>
			request(GitDiff, gitDiffUrl(workspaceId, projectId, path)),
	});
}
