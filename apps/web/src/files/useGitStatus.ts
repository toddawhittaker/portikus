/**
 * One project's Git state (SPEC.md §12.1, §12.8). Ignored paths are only
 * fetched when hidden files are shown, so the hidden flag is part of the key.
 * Freshness comes from the project events socket, not from a poll.
 */
import { GitStatus } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { fileKeys } from "./queries.js";
import { useShowHidden } from "./store.js";

export function gitStatusUrl(
	workspaceId: string,
	projectId: string,
	hidden: boolean,
): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/git/status?hidden=${hidden}`;
}

export function useGitStatus(workspaceId: string, projectId: string) {
	const hidden = useShowHidden(projectId);
	return useQuery({
		queryKey: fileKeys.git(workspaceId, projectId, hidden),
		queryFn: () => request(GitStatus, gitStatusUrl(workspaceId, projectId, hidden)),
	});
}
