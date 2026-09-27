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
import { isFileExists } from "./errors.js";
import { isDescendant, parentOf } from "./paths.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}`;

export const fileKeys = {
	tree: (workspaceId: string, projectId: string, dir: string) =>
		["files", workspaceId, projectId, dir] as const,
	file: (workspaceId: string, projectId: string, path: string) =>
		["file", workspaceId, projectId, path] as const,
	diff: (workspaceId: string, projectId: string, path: string) =>
		["git-diff", workspaceId, projectId, path] as const,
	git: (workspaceId: string, projectId: string, hidden: boolean) =>
		["git-status", workspaceId, projectId, hidden] as const,
	/** The student's own file actions, so a project too large to watch can refresh after them. */
	actions: (workspaceId: string, projectId: string) =>
		["file-action", workspaceId, projectId] as const,
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

/**
 * Start a download once the API says it is under the size cap. The check
 * adds up file sizes without zipping, so a refusal is explained in the page
 * rather than shown as a failed download (#399). `checkUrl` is a download
 * URL with `check=1`.
 */
export async function startDownload(
	href: string,
	checkUrl: string,
	name: string,
): Promise<void> {
	const response = await fetch(checkUrl, { credentials: "same-origin" });
	if (!response.ok) throw await toApiError(response);
	const link = document.createElement("a");
	link.href = href;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
}

/** The size check for a download of one file or folder; "" is the project. */
export function downloadCheckUrl(
	workspaceId: string,
	projectId: string,
	path: string,
): string {
	return `${directoryDownloadUrl(workspaceId, projectId, path)}&check=1`;
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
 * One directory listing, fetched while the directory is mounted. Nothing
 * polls any more: the project events socket refetches the listing when
 * something in that directory changes (SPEC.md §11.4, useProjectEvents.ts).
 */
export function useTree(workspaceId: string, projectId: string, dir: string) {
	return useQuery({
		queryKey: fileKeys.tree(workspaceId, projectId, dir),
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
	const mutationKey = fileKeys.actions(workspaceId, projectId);

	const createFile = useMutation({
		mutationKey,
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
		mutationKey,
		mutationFn: (path: string) =>
			request(z.unknown(), `${base(workspaceId, projectId)}/mkdir`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path }),
			}),
		onSuccess: (_data, path) => invalidate(parentOf(path)),
	});

	const move = useMutation({
		mutationKey,
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
		mutationKey,
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
		mutationKey,
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
 * One file's text. Nothing polls any more: an edit made by a coding agent or
 * a shell arrives on the project events socket, which refetches this file
 * (SPEC.md §11.4, §13.3).
 */
export function useFile(workspaceId: string, projectId: string, path: string) {
	return useQuery({
		queryKey: fileKeys.file(workspaceId, projectId, path),
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
		mutationKey: fileKeys.actions(workspaceId, projectId),
		// A saved file changes its diff, and this is the quickest way to say
		// so; the project events socket would get there a moment later.
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

/**
 * Save a pasted picture at the first of `paths` that is free, and return it, creating `.portikus/pastes` first because
 * mkdir needs its parent to exist. A folder that is already there is fine;
 * the file itself is never overwritten (SPEC.md §11.2, §13.5).
 */
export async function savePastedImage(
	workspaceId: string,
	projectId: string,
	paths: readonly string[],
	image: Blob,
): Promise<string> {
	for (const dir of [".portikus", ".portikus/pastes"]) {
		try {
			await request(z.unknown(), `${base(workspaceId, projectId)}/mkdir`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: dir }),
			});
		} catch (error) {
			if (!isFileExists(error)) throw error;
		}
	}
	let lastError: unknown;
	for (const path of paths) {
		try {
			await request(WriteFileResponse, fileUrl(workspaceId, projectId, path), {
				method: "PUT",
				headers: {
					"if-none-match": "*",
					"content-type": "application/octet-stream",
				},
				body: image,
			});
			return path;
		} catch (error) {
			if (!isFileExists(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}
