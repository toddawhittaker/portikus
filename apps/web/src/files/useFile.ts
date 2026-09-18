/**
 * Reading and writing one file through the control plane (SPEC.md §11.1,
 * §13.5). Writes are conditional on the etag the browser last read, so stale
 * content can never overwrite a newer file on disk.
 */
import { ApiError as ApiErrorBody } from "@portikus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, SessionEndedError } from "../api/request.js";

/** What the editor needs about one file. */
export interface FileContent {
	text: string;
	etag: string;
	contentType: string;
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

export const fileKeys = {
	file: (workspaceId: string, projectId: string, path: string) =>
		["file", workspaceId, projectId, path] as const,
};

export function fileUrl(
	workspaceId: string,
	projectId: string,
	path: string,
	download = false,
): string {
	const query = new URLSearchParams({ path });
	if (download) query.set("download", "1");
	return `/workspaces/${workspaceId}/projects/${projectId}/file?${query}`;
}

/** Turn an error response into the error the caller should see. */
async function failure(response: Response): Promise<Error> {
	if (response.status === 401) return new SessionEndedError();
	const body = await response.json().catch(() => null);
	const parsed = ApiErrorBody.safeParse(body);
	return new ApiError(
		response.status,
		parsed.success ? parsed.data.message : "Something went wrong. Please try again.",
		parsed.success ? parsed.data.code : undefined,
	);
}

/**
 * One file's text. Polled, because the filesystem event pipe that would push
 * an external change arrives in a later task; until then this is how an edit
 * by an agent or a shell is noticed (SPEC.md §13.3).
 */
export function useFile(workspaceId: string, projectId: string, path: string) {
	return useQuery({
		queryKey: fileKeys.file(workspaceId, projectId, path),
		refetchInterval: 5000,
		refetchOnWindowFocus: true,
		retry: false,
		queryFn: async (): Promise<FileContent> => {
			const response = await fetch(fileUrl(workspaceId, projectId, path), {
				credentials: "same-origin",
			});
			const size = Number(response.headers.get("content-length") ?? 0);
			if (response.status === 413) {
				return { text: "", etag: "", contentType: "", size: 0, tooLarge: true };
			}
			if (!response.ok) throw await failure(response);
			const etag = response.headers.get("etag") ?? "";
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.startsWith("text/")) {
				return { text: "", etag, contentType, size, binary: true };
			}
			return { text: await response.text(), etag, contentType, size };
		},
	});
}

export interface SaveFileInput {
	text: string;
	/** The etag this text was edited from. */
	etag: string;
}

/** Write a file, conditional on its etag; a 412 becomes a FileConflictError. */
export function useSaveFile(workspaceId: string, projectId: string, path: string) {
	return useMutation({
		mutationFn: async ({ text, etag }: SaveFileInput): Promise<{ etag: string }> => {
			const response = await fetch(fileUrl(workspaceId, projectId, path), {
				method: "PUT",
				credentials: "same-origin",
				headers: {
					"if-match": etag,
					"content-type": "text/plain; charset=utf-8",
				},
				body: text,
			});
			if (response.status === 412) {
				throw new FileConflictError(response.headers.get("etag") ?? "");
			}
			if (!response.ok) throw await failure(response);
			const body = (await response.json()) as { etag?: string };
			return { etag: body.etag ?? "" };
		},
	});
}
