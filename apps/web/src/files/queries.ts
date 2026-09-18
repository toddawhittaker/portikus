/**
 * The file tree's server state (SPEC.md §11.2). One query per directory, so
 * expanding a directory is the thing that fetches it, and every change
 * refetches only the directory it happened in.
 */
import { TreeResponse, WriteFileResponse } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";
import { parentOf } from "./paths.js";

const base = (workspaceId: string, projectId: string) =>
	`/workspaces/${workspaceId}/projects/${projectId}`;

export const fileKeys = {
	all: (workspaceId: string, projectId: string) =>
		["files", workspaceId, projectId] as const,
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
 * One directory listing. `enabled` is false until the directory is open, so
 * a closed directory costs nothing.
 *
 * Polling and the refetch on focus are an interim stand-in for the live
 * filesystem events of SPEC.md §11.4, which arrive with the events task.
 */
export function useTree(
	workspaceId: string,
	projectId: string,
	dir: string,
	enabled = true,
) {
	return useQuery({
		queryKey: fileKeys.tree(workspaceId, projectId, dir),
		enabled,
		refetchOnWindowFocus: true,
		refetchInterval: 10_000,
		queryFn: () => request(TreeResponse, treeUrl(workspaceId, projectId, dir)),
	});
}

export interface FileMutations {
	createFile: (path: string) => Promise<unknown>;
	createDirectory: (path: string) => Promise<unknown>;
	move: (from: string, to: string) => Promise<unknown>;
	remove: (path: string) => Promise<unknown>;
	upload: (path: string, file: File) => Promise<unknown>;
	pending: boolean;
}

/**
 * Every change the tree can make. Each one refetches the directory it
 * touched; a move refetches both ends.
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

	// A create must not overwrite what is already there, so it is conditional
	// on the file not existing (SPEC.md §13.5).
	const createFile = useMutation({
		mutationFn: (path: string) =>
			request(WriteFileResponse, url(path), {
				method: "PUT",
				headers: { "if-none-match": "*", "content-type": "application/octet-stream" },
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
		onSuccess: (_data, { from, to }) => invalidate(parentOf(from), parentOf(to)),
	});

	const remove = useMutation({
		mutationFn: (path: string) =>
			request(z.undefined(), url(path), { method: "DELETE" }),
		onSuccess: (_data, path) => invalidate(parentOf(path)),
	});

	// An upload never silently replaces a file: the agent requires a condition
	// on every write, and "must not exist" is the safe one here. A clash comes
	// back as 409 and the tree says the name is taken (SPEC.md §11.2, §13.5).
	const upload = useMutation({
		mutationFn: ({ path, file }: { path: string; file: File }) =>
			request(WriteFileResponse, url(path), {
				method: "PUT",
				headers: {
					"if-none-match": "*",
					"content-type": "application/octet-stream",
				},
				body: file,
			}),
		onSuccess: (_data, { path }) => invalidate(parentOf(path)),
	});

	return {
		createFile: (path) => createFile.mutateAsync(path),
		createDirectory: (path) => createDirectory.mutateAsync(path),
		move: (from, to) => move.mutateAsync({ from, to }),
		remove: (path) => remove.mutateAsync(path),
		upload: (path, file) => upload.mutateAsync({ path, file }),
		pending:
			createFile.isPending ||
			createDirectory.isPending ||
			move.isPending ||
			remove.isPending ||
			upload.isPending,
	};
}
