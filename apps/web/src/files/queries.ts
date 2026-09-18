/**
 * The file tree's server state (SPEC.md §11.2). One query per directory, so
 * expanding a directory is the thing that fetches it, and every change
 * refetches only the directory it happened in.
 */
import { TreeResponse, WriteFileResponse } from "@portikus/contracts";
import {
	type UseMutationResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";
import { isDescendant, parentOf } from "./paths.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}`;

export const fileKeys = {
	tree: (workspaceId: string, projectId: string, dir: string) =>
		["files", workspaceId, projectId, dir] as const,
};

function treeUrl(workspaceId: string, projectId: string, dir: string): string {
	return `${base(workspaceId, projectId)}/tree?path=${encodeURIComponent(dir)}`;
}

function fileUrl(workspaceId: string, projectId: string, path: string): string {
	return `${base(workspaceId, projectId)}/file?path=${encodeURIComponent(path)}`;
}

/** The link that downloads one file to disk. */
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
			invalidate(parentOf(from), parentOf(to));
		},
	});

	const remove = useMutation({
		mutationFn: (path: string) =>
			request(z.undefined(), url(path), { method: "DELETE" }),
		onSuccess: (_data, path) => {
			forgetSubtree(path);
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
