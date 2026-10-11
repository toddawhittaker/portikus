/**
 * The server state behind an instructor's read-only view of a shared project
 * (SPEC.md §5.2, ADR 0057). There is no events socket for someone else's
 * project, so every read polls.
 */
import {
	CourseSharesResponse,
	SharedChecksResponse,
	SharedGitDiffResponse,
	SharedGitStatusResponse,
	SharedTreeResponse,
} from "@portikus/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, request, toApiError } from "../../api/request.js";
import { baseName, parentOf } from "../../files/paths.js";
import { joinPages } from "../../files/queries.js";

/** How often the view asks again (ADR 0057). */
export const SHARE_POLL_MS = 10_000;

/** Ids that name one shared project. */
export interface ShareRef {
	courseId: string;
	projectId: string;
}

const base = ({ courseId, projectId }: ShareRef) =>
	`/courses/${courseId}/shares/${projectId}`;

const keys = {
	all: (ref: ShareRef) => ["shared-project", ref.courseId, ref.projectId] as const,
	tree: (ref: ShareRef, dir: string) => [...keys.all(ref), "tree", dir] as const,
	file: (ref: ShareRef, path: string, version: string | undefined) =>
		[...keys.all(ref), "file", path, version] as const,
	git: (ref: ShareRef) => [...keys.all(ref), "git"] as const,
	diff: (ref: ShareRef, path: string) => [...keys.all(ref), "diff", path] as const,
	checks: (ref: ShareRef) => [...keys.all(ref), "checks"] as const,
};

/** Why the view cannot show the project, if it is one of the two expected reasons. */
export type ShareProblem = "stopped" | "gone";

/** The API's answer for a stopped workspace (409) or a share that is not there (404). */
export function shareProblem(error: unknown): ShareProblem | null {
	if (!(error instanceof ApiError)) return null;
	if (error.status === 409 && error.code === "WORKSPACE_NOT_RUNNING") return "stopped";
	// A missing file is FILE_NOT_FOUND; only the share gate answers NOT_FOUND.
	if (error.status === 404 && error.code === "NOT_FOUND") return "gone";
	return null;
}

/** The open shares of the course, for the project's name and owner. */
export function useCourseShares(courseId: string) {
	return useQuery({
		queryKey: ["courses", courseId, "shares"],
		queryFn: () => request(CourseSharesResponse, `/courses/${courseId}/shares`),
		refetchInterval: SHARE_POLL_MS,
	});
}

/** One directory of the shared project, every page shown so far. */
export function useSharedTree(ref: ShareRef, dir: string) {
	return useInfiniteQuery({
		queryKey: keys.tree(ref, dir),
		queryFn: ({ pageParam }) => {
			const query = new URLSearchParams({ path: dir });
			if (pageParam !== undefined) query.set("after", pageParam);
			return request(SharedTreeResponse, `${base(ref)}/tree?${query}`);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next,
		select: joinPages,
		refetchInterval: SHARE_POLL_MS,
	});
}

export function useSharedGitStatus(ref: ShareRef) {
	return useQuery({
		queryKey: keys.git(ref),
		queryFn: () => request(SharedGitStatusResponse, `${base(ref)}/git/status`),
		refetchInterval: SHARE_POLL_MS,
	});
}

/** One file's changes, HEAD against the working tree. */
export function useSharedGitDiff(ref: ShareRef, path: string) {
	return useQuery({
		queryKey: keys.diff(ref, path),
		queryFn: () =>
			request(
				SharedGitDiffResponse,
				`${base(ref)}/git/diff?${new URLSearchParams({ path })}`,
			),
		refetchInterval: SHARE_POLL_MS,
	});
}

export function useSharedChecks(ref: ShareRef) {
	return useQuery({
		queryKey: keys.checks(ref),
		queryFn: () => request(SharedChecksResponse, `${base(ref)}/checks`),
		refetchInterval: SHARE_POLL_MS,
	});
}

/** One file as the view can show it: its text, or why it is not shown as text. */
export interface SharedFileContent {
	text: string;
	/** Past the editor limit (SPEC.md §13.2). */
	tooLarge?: boolean;
	/** Not text, and not a picture or PDF either. */
	binary?: boolean;
}

/** The address of one file's bytes. */
function fileUrl(ref: ShareRef, path: string): string {
	return `${base(ref)}/file?${new URLSearchParams({ path })}`;
}

/**
 * A file's size and modified time from the listing the tree already polls,
 * so a changed file gets a new version and an unchanged one is not re-read.
 * Undefined once the file is gone from its folder.
 */
export function useSharedFileVersion(ref: ShareRef, path: string): string | undefined {
	const listing = useSharedTree(ref, parentOf(path));
	const entry = listing.data?.entries.find((item) => item.name === baseName(path));
	return entry ? `${entry.size}-${entry.mtimeMs}` : undefined;
}

/** One file's text, read again only when its version changes. */
export function useSharedFile(
	ref: ShareRef,
	path: string,
	version: string | undefined,
) {
	return useQuery({
		queryKey: keys.file(ref, path, version),
		// Keeps the old text on screen while a new version loads.
		placeholderData: keepPreviousData,
		// No version means the listing page is not loaded, so poll instead.
		refetchInterval: version === undefined ? SHARE_POLL_MS : false,
		queryFn: async (): Promise<SharedFileContent> => {
			const response = await fetch(fileUrl(ref, path), { credentials: "same-origin" });
			if (response.status === 413) return { text: "", tooLarge: true };
			if (!response.ok) throw await toApiError(response);
			const type = response.headers.get("content-type") ?? "";
			if (!type.startsWith("text/")) {
				await response.body?.cancel();
				return { text: "", binary: true };
			}
			return { text: await response.text() };
		},
	});
}

/**
 * The same file as an image or PDF the page can show. `version` changes when
 * the file does, so the browser loads the new picture.
 */
export function sharedInlineUrl(ref: ShareRef, path: string, version?: string): string {
	const query = new URLSearchParams({ path, inline: "1" });
	if (version) query.set("v", version);
	return `${base(ref)}/file?${query}`;
}
