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

function gitStatusUrl(
	workspaceId: string,
	projectId: string,
	hidden: boolean,
	baseline?: string,
): string {
	const base = `/workspaces/${workspaceId}/projects/${projectId}`;
	// Session review is a different route: GitStatus against the launcher's
	// object id (SPEC.md §12.7). HEAD status stays on git/status.
	if (baseline) {
		const query = new URLSearchParams({ object: baseline });
		return `${base}/baseline-status?${query}`;
	}
	return `${base}/git/status?hidden=${hidden}`;
}

/**
 * `baseline` set: compare the working tree with that object id.
 * `baseline` omitted: Git HEAD, as before. Pass `{ baseline: undefined }`
 * to stay mounted without fetching a session comparison.
 */
export function useGitStatus(
	workspaceId: string,
	projectId: string,
	options?: { baseline?: string },
) {
	const hidden = useShowHidden(projectId);
	const baseline = options?.baseline;
	const session = options !== undefined;
	return useQuery({
		queryKey: session
			? [
					...fileKeys.git(workspaceId, projectId, hidden).slice(0, 3),
					"baseline",
					baseline ?? "",
				]
			: fileKeys.git(workspaceId, projectId, hidden),
		enabled: !session || baseline !== undefined,
		queryFn: () =>
			request(GitStatus, gitStatusUrl(workspaceId, projectId, hidden, baseline)),
	});
}
