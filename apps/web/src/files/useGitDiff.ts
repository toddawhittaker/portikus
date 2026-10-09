/**
 * One file's diff, HEAD against the working tree (SPEC.md §12.6), or another
 * base when one is given: a session baseline, a Git ref, or a recovery
 * point. Nothing polls: the project events socket
 * invalidates this query when the file or the repository changes, and coming
 * back to the window or to the tab asks again in case the socket was away.
 * A recovery point is the exception: reading it can take a minute
 * (SPEC.md §15.8), so it is read only when the student presses Compare.
 */
import { GitDiff } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { recoveryKeys, recoveryPointDiffUrl } from "../recovery/queries.js";
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

/** The query key: the file's diff key and the base, or the point's own key. */
function diffKey(
	workspaceId: string,
	projectId: string,
	path: string,
	base: DiffBase | undefined,
): readonly string[] {
	if (base?.kind === "point") {
		return recoveryKeys.pointDiff(workspaceId, projectId, base.pointId, path);
	}
	// A prefix of the file's key, so invalidating the file refreshes every base.
	const file = fileKeys.diff(workspaceId, projectId, path);
	if (base?.kind === "baseline") return [...file, base.object];
	if (base?.kind === "ref") return [...file, "ref", base.ref];
	return file;
}

export function useGitDiff(
	workspaceId: string,
	projectId: string,
	path: string,
	base?: DiffBase,
) {
	const point = base?.kind === "point";
	return useQuery({
		queryKey: diffKey(workspaceId, projectId, path, base),
		// Coming back to the window is another moment a diff can notice a
		// change; a stale window would waste it. A point is read on Compare only.
		refetchOnWindowFocus: !point,
		staleTime: point ? Number.POSITIVE_INFINITY : 0,
		retry: false,
		// Leaving a diff, or replacing it, cancels its read.
		queryFn: ({ signal }): Promise<GitDiff> =>
			request(GitDiff, gitDiffUrl(workspaceId, projectId, path, base), { signal }),
	});
}
