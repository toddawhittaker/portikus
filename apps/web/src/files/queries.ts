/**
 * The files server state (SPEC.md §11.2, §13.5). Two halves share one URL
 * helper: the tree keeps one query per directory, so expanding a directory
 * fetches it and every change refetches only the directory it happened in;
 * the editor keeps one query per open file, and writes it conditionally on
 * the etag the browser last read so stale content cannot overwrite a newer
 * file on disk.
 */
import { TreeResponse, WriteFileResponse } from "@portikus/contracts";
import {
	type UseMutationResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { request, toApiError } from "../api/request.js";
import { isDescendant, parentOf } from "./paths.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}`;

export const fileKeys = {
	tree: (workspaceId: string, projectId: string, dir: string) =>
		["files", workspaceId, projectId, dir] as const,
	file: (workspaceId: string, projectId: string, path: string) =>
		["file", workspaceId, projectId, path] as const,
};

function treeUrl(workspaceId: string, projectId: string, dir: string): string {
	return `${base(workspaceId, projectId)}/tree?path=${encodeURIComponent(dir)}`;
}

/** The URL of one file, for reading and writing. */
export function fileUrl(workspaceId: string, projectId: string, path: string): string {
	return `${base(workspaceId, projectId)}/file?path=${encodeURIComponent(path)}`;
}

/** The same file with the flag that makes the browser save it to disk. */
export function fileDownloadUrl(
	workspaceId: string,
	projectId: string,
	path: string,
): string {
	return `${fileUrl(workspaceId, projectId, path)}&download=1`;
}

/** The link that downloads one directory as a zip; "" is the whole project. */
export function directoryDownloadUrl(
	workspaceId: string,
	projectId: string,
	path: string,
): string {
	return `${base(workspaceId, projectId)}/download?path=${encodeURIComponent(path)}`;
}

/**
 * One directory listing, fetched while the directory is mounted.
 *
 * The ten-second poll is an interim stand-in for the live filesystem events
 * of SPEC.md §11.4: the agent already publishes them on its socket, but the
 * API relay and the browser consumer arrive with a later task.
 */
export function useTree(workspaceId: string, projectId: string, dir: string) {
	return useQuery({
		queryKey: fileKeys.tree(workspaceId, projectId, dir),
		refetchInterval: 10_000,
		queryFn: () => request(TreeResponse, treeUrl(workspaceId, projectId, dir)),
	});
}

export interface FileMutations {
	createFile: UseMutationResult<WriteFileResponse, Error, string>;
	createDirectory: UseMutationResult<unknown, Error, string>;
	move: UseMutationResult<undefined, Error, { from: string; to: string }>;
	remove: UseMutationResult<undefined, Error, string>;
	upload: UseMutationResult<
		WriteFileResponse,
		Error,
		{ path: string; file: File; replace?: boolean }
	>;
	pending: boolean;
}

/**
 * Every change the tree can make. Each one refetches the directory it
 * touched; a move refetches both ends. A directory that is gone, or that
 * moved, takes its cached listings with it, so nothing stale is left to
 * draw if it comes back.
 */
export function useFileMutations(
	workspaceId: string,
	projectId: string,
): FileMutations {
	const client = useQueryClient();
	const url = (path: string) => fileUrl(workspaceId, projectId, path);

	function invalidate(...dirs: string[]) {
		for (const dir of new Set(dirs)) {
			void client.invalidateQueries({
				queryKey: fileKeys.tree(workspaceId, projectId, dir),
			});
		}
	}

	/** Forget the listing for `dir` and for every directory inside it. */
	function forgetSubtree(dir: string) {
		client.removeQueries({
			predicate: (query) => {
				const key = query.queryKey;
				if (key[0] !== "files" || key[1] !== workspaceId || key[2] !== projectId) {
					return false;
				}
				const cached = key[3];
				return (
					typeof cached === "string" && (cached === dir || isDescendant(cached, dir))
				);
			},
		});
	}

	// A moved or deleted file may be open in an editor tab, so its query is
	// refetched: the tab then sees the new content, or that the file is gone
	// (SPEC.md §13.3).
	function invalidateOpenFiles(path: string) {
		void client.invalidateQueries({
			predicate: (query) => {
				const key = query.queryKey;
				if (key[0] !== "file" || key[1] !== workspaceId || key[2] !== projectId) {
					return false;
				}
				const cached = key[3];
				return (
					typeof cached === "string" && (cached === path || isDescendant(cached, path))
				);
			},
		});
	}

	// A create must not overwrite what is already there, so it is conditional
	// on the file not existing (SPEC.md §13.5).
	const createFile = useMutation({
		mutationFn: (path: string) =>
			request(WriteFileResponse, url(path), {
				method: "PUT",
				headers: {
					"if-none-match": "*",
					"content-type": "application/octet-stream",
				},
				body: new Blob([]),
			}),
		onSuccess: (_data, path) => invalidate(parentOf(path)),
	});

	const createDirectory = useMutation({
		mutationFn: (path: string) =>
			request(z.unknown(), `${base(workspaceId, projectId)}/mkdir`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path }),
			}),
		onSuccess: (_data, path) => invalidate(parentOf(path)),
	});

	const move = useMutation({
		mutationFn: ({ from, to }: { from: string; to: string }) =>
			request(z.undefined(), `${base(workspaceId, projectId)}/move`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ from, to }),
			}),
		onSuccess: (_data, { from, to }) => {
			forgetSubtree(from);
			invalidateOpenFiles(from);
			invalidate(parentOf(from), parentOf(to));
		},
	});

	const remove = useMutation({
		mutationFn: (path: string) =>
			request(z.undefined(), url(path), { method: "DELETE" }),
		onSuccess: (_data, path) => {
			forgetSubtree(path);
			invalidateOpenFiles(path);
			invalidate(parentOf(path));
		},
	});

	// An upload never silently replaces a file: the agent requires a condition
	// on every write, and "must not exist" is the safe one here. A clash comes
	// back as 409 and the tree offers to replace instead (SPEC.md §11.2, §13.5).
	const upload = useMutation({
		mutationFn: ({
			path,
			file,
			replace,
		}: {
			path: string;
			file: File;
			replace?: boolean;
		}) =>
			request(WriteFileResponse, url(path), {
				method: "PUT",
				headers: {
					...(replace ? { "if-match": "*" } : { "if-none-match": "*" }),
					"content-type": "application/octet-stream",
				},
				body: file,
			}),
		onSuccess: (_data, { path }) => invalidate(parentOf(path)),
	});

	return {
		createFile,
		createDirectory,
		move,
		remove,
		upload,
		pending:
			createFile.isPending ||
			createDirectory.isPending ||
			move.isPending ||
			remove.isPending ||
			upload.isPending,
	};
}

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
	return useMutation({
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
