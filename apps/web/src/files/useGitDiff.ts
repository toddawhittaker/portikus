/**
 * One file's diff, HEAD against the working tree (SPEC.md §12.6), or another
 * base when one is given: a session baseline, a Git ref, or a recovery
 * point. Nothing polls: the project events socket
 * invalidates this query when the file or the repository changes, and coming
 * back to the window or to the tab asks again in case the socket was away.
 */
import { GitDiff } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { recoveryPointDiffUrl } from "../recovery/queries.js";
import { fileKeys } from "./queries.js";

/**
 * What the working copy is compared with when it is not Git HEAD: the
 * session baseline object (SPEC.md §12.7), a Git ref the student typed
 * (SPEC.md §12.6), or a recovery point (SPEC.md §15.8). A point carries the
 * label the view shows for it.
 */
export type DiffBase =
	| { kind: "baseline"; object: string }
	| { kind: "ref"; ref: string }
	| { kind: "point"; pointId: string; label: string };

/** The URL of one file's diff against `base`, or against HEAD without one. */
function gitDiffUrl(
	workspaceId: string,
	projectId: string,
	path: string,
	base?: DiffBase,
): string {
	const prefix = `/workspaces/${workspaceId}/projects/${projectId}`;
	if (base?.kind === "baseline") {
		const query = new URLSearchParams({ object: base.object, path });
		return `${prefix}/baseline-diff?${query}`;
	}
	if (base?.kind === "point") {
		return recoveryPointDiffUrl(workspaceId, projectId, base.pointId, path);
	}
	const query = new URLSearchParams({ path });
	if (base?.kind === "ref") query.set("ref", base.ref);
	return `${prefix}/git/diff?${query}`;
}

/** The base's part of the query key; the file's own key stays the prefix. */
function baseKey(base: DiffBase | undefined): string[] {
	if (base?.kind === "baseline") return [base.object];
	if (base?.kind === "ref") return ["ref", base.ref];
	if (base?.kind === "point") return ["point", base.pointId];
	return [];
}

export function useGitDiff(
	workspaceId: string,
	projectId: string,
	path: string,
	base?: DiffBase,
) {
	return useQuery({
		// A prefix of the file's key, so invalidating the file refreshes every base.
		queryKey: [...fileKeys.diff(workspaceId, projectId, path), ...baseKey(base)],
		refetchOnWindowFocus: true,
		// Coming back to the window is another moment a diff can notice a
		// change; a stale window would waste it.
		staleTime: 0,
		retry: false,
		queryFn: (): Promise<GitDiff> =>
			request(GitDiff, gitDiffUrl(workspaceId, projectId, path, base)),
	});
}
