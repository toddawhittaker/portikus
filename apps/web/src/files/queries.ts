/**
 * Reading and writing one file through the control plane (SPEC.md §11.1,
 * §13.5). Writes are conditional on the etag the browser last read, so stale
 * content can never overwrite a newer file on disk.
 */
import { WriteFileResponse } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError } from "../api/request.js";

/** What the editor needs about one file. */
export interface FileContent {
	text: string;
	etag: string;
	size: number;
	/** The file is past the editor limit, so only the download flow is offered. */
	tooLarge?: boolean;
	/** The file is not text, so it opens in the viewer (SPEC.md §13.2). */
	binary?: boolean;
}

/** Thrown when a write lost a race with another writer (SPEC.md §13.5). */
export class FileConflictError extends Error {
	/** The file's etag as it is on disk now. */
	readonly etag: string;

	constructor(etag: string) {
		super("This file changed on disk since it was opened.");
		this.name = "FileConflictError";
		this.etag = etag;
	}
}

/**
 * Said when the server answers without an etag. Without one the next write
 * would send an empty If-Match and be refused, so the editor says so rather
 * than saving into a dead end.
 */
const NO_READ_ETAG =
	"The server did not say which version of this file it sent, so it cannot be saved safely.";

const NO_WRITE_ETAG =
	"The server did not say which version it saved, so this file cannot be saved safely.";

export const fileKeys = {
	file: (workspaceId: string, projectId: string, path: string) =>
		["file", workspaceId, projectId, path] as const,
	diff: (workspaceId: string, projectId: string, path: string) =>
		["git-diff", workspaceId, projectId, path] as const,
};

/** The URL of one file, for reading and writing. */
export function fileUrl(workspaceId: string, projectId: string, path: string): string {
	const query = new URLSearchParams({ path });
	return `/workspaces/${workspaceId}/projects/${projectId}/file?${query}`;
}

/** The same file with the flag that makes the browser save it to disk. */
export function fileDownloadUrl(
	workspaceId: string,
	projectId: string,
	path: string,
): string {
	return `${fileUrl(workspaceId, projectId, path)}&download=1`;
}

/**
 * One file's text. Polled while its tab is visible, because the filesystem
 * event pipe that would push an external change arrives in a later task;
 * until then this is how an edit by an agent or a shell is noticed
 * (SPEC.md §13.3).
 */
export function useFile(
	workspaceId: string,
	projectId: string,
	path: string,
	visible = true,
) {
	return useQuery({
		queryKey: fileKeys.file(workspaceId, projectId, path),
		refetchInterval: visible ? 5000 : false,
		refetchOnWindowFocus: true,
		retry: false,
		queryFn: async (): Promise<FileContent> => {
			const response = await fetch(fileUrl(workspaceId, projectId, path), {
				credentials: "same-origin",
			});
			const size = Number(response.headers.get("content-length") ?? 0);
			if (response.status === 413) {
				return { text: "", etag: "", size: 0, tooLarge: true };
			}
			if (!response.ok) throw await toApiError(response);
			const etag = response.headers.get("etag");
			if (!etag) throw new Error(NO_READ_ETAG);
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.startsWith("text/")) {
				return { text: "", etag, size, binary: true };
			}
			return { text: await response.text(), etag, size };
		},
	});
}

export interface SaveFileInput {
	text: string;
	/**
	 * The etag this text was edited from, or null to create the file again
	 * because it was deleted on disk while it was open (SPEC.md §13.3).
	 */
	etag: string | null;
}

/** The headers that make a write conditional: replace a version, or create. */
function writeHeaders(etag: string | null): Record<string, string> {
	return {
		...(etag === null ? { "if-none-match": "*" } : { "if-match": etag }),
		"content-type": "text/plain; charset=utf-8",
	};
}

/** Write a file, conditional on its etag; a 412 becomes a FileConflictError. */
export function useSaveFile(workspaceId: string, projectId: string, path: string) {
	const queryClient = useQueryClient();
	return useMutation({
		// A saved file changes its diff, and nothing else invalidates it until
		// the project events consumer lands (task 11 of this epic).
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: fileKeys.diff(workspaceId, projectId, path),
			});
		},
		mutationFn: async ({ text, etag }: SaveFileInput): Promise<{ etag: string }> => {
			const response = await fetch(fileUrl(workspaceId, projectId, path), {
				method: "PUT",
				credentials: "same-origin",
				headers: writeHeaders(etag),
				body: text,
			});
			if (response.status === 412) {
				throw new FileConflictError(response.headers.get("etag") ?? "");
			}
			if (!response.ok) throw await toApiError(response);
			const parsed = WriteFileResponse.safeParse(
				await response.json().catch(() => null),
			);
			if (!parsed.success) throw new Error(NO_WRITE_ETAG);
			return { etag: parsed.data.etag };
		},
	});
}

/**
 * Write the file outside React Query, for the unmount path: `keepalive` lets
 * the request outlive the page, so closing the tab while the autosave is
 * still waiting does not lose the last keystrokes (SPEC.md §13.5).
 */
export function flushWrite(
	workspaceId: string,
	projectId: string,
	path: string,
	text: string,
	etag: string | null,
): void {
	void fetch(fileUrl(workspaceId, projectId, path), {
		method: "PUT",
		credentials: "same-origin",
		headers: writeHeaders(etag),
		body: text,
		keepalive: true,
	}).catch(() => {});
}
