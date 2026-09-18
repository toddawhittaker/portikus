/**
 * The browser end of the project events socket (SPEC.md §11.4, §25.1). One
 * socket per open project tells the browser what changed on disk, so the
 * tree, the open files and the Git status are refetched within a couple of
 * seconds of a change made in a terminal or by a coding agent, and nothing
 * polls.
 */
import { FsEvent } from "@portikus/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { parentOf } from "./paths.js";
import { fileKeys } from "./queries.js";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
/** Frames are collected this long before anything is refetched. */
export const INVALIDATE_DEBOUNCE_MS = 300;

/** What a batch of frames asks the query cache to refetch. */
export interface Invalidations {
	git: boolean;
	/** Directory listings, by directory path. */
	trees: string[];
	/** Open file contents, by file path. */
	files: string[];
	/** Too many changes to name: refetch every tree and file of the project. */
	all: boolean;
}

/** Fold a batch of frames into the one set of refetches they need. */
export function invalidationsFor(frames: readonly FsEvent[]): Invalidations {
	const trees = new Set<string>();
	const files = new Set<string>();
	let git = false;
	let all = false;
	for (const frame of frames) {
		if (frame.git) git = true;
		if (frame.truncated) all = true;
		for (const path of frame.paths) {
			files.add(path);
			trees.add(parentOf(path));
		}
	}
	return {
		git,
		all,
		trees: all ? [] : [...trees],
		files: all ? [] : [...files],
	};
}

function socketUrl(workspaceId: string, projectId: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/workspaces/${workspaceId}/projects/${projectId}/events`;
}

/** Apply one folded batch to the query cache. */
export function applyInvalidations(
	client: QueryClient,
	workspaceId: string,
	projectId: string,
	work: Invalidations,
): void {
	if (work.git) {
		// Both hidden states, because only one of them is mounted right now.
		for (const hidden of [false, true]) {
			void client.invalidateQueries({
				queryKey: fileKeys.git(workspaceId, projectId, hidden),
			});
		}
		// A commit or a staged change rewrites every open diff.
		void client.invalidateQueries({
			predicate: (query) => {
				const key = query.queryKey;
				return key[0] === "git-diff" && key[1] === workspaceId && key[2] === projectId;
			},
		});
	}
	if (work.all) {
		void client.invalidateQueries({
			predicate: (query) => {
				const key = query.queryKey;
				return (
					(key[0] === "files" || key[0] === "file" || key[0] === "git-diff") &&
					key[1] === workspaceId &&
					key[2] === projectId
				);
			},
		});
		return;
	}
	for (const dir of work.trees) {
		void client.invalidateQueries({
			queryKey: fileKeys.tree(workspaceId, projectId, dir),
		});
	}
	for (const path of work.files) {
		void client.invalidateQueries({
			queryKey: fileKeys.file(workspaceId, projectId, path),
		});
		void client.invalidateQueries({
			queryKey: fileKeys.diff(workspaceId, projectId, path),
		});
	}
}

/**
 * Keep one events socket open while the project is on screen. A socket that
 * drops is opened again with a backoff, because a workspace that is
 * restarting should not be hammered.
 */
export function useProjectEvents(workspaceId: string, projectId: string): void {
	const client = useQueryClient();

	useEffect(() => {
		let stopped = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let debounce: ReturnType<typeof setTimeout> | undefined;
		let backoffMs = FIRST_RETRY_MS;
		let pending: FsEvent[] = [];

		function flush(): void {
			debounce = undefined;
			const frames = pending;
			pending = [];
			if (frames.length === 0) return;
			applyInvalidations(client, workspaceId, projectId, invalidationsFor(frames));
		}

		function connect(): void {
			if (stopped) return;
			const next = new WebSocket(socketUrl(workspaceId, projectId));
			socket = next;

			next.onopen = () => {
				backoffMs = FIRST_RETRY_MS;
			};

			next.onmessage = (event: MessageEvent) => {
				let frame: unknown;
				try {
					frame = JSON.parse(String(event.data));
				} catch {
					return;
				}
				const parsed = FsEvent.safeParse(frame);
				if (!parsed.success) return;
				pending.push(parsed.data);
				if (debounce === undefined)
					debounce = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
			};

			next.onclose = () => {
				if (stopped) return;
				retry = setTimeout(connect, backoffMs);
				backoffMs = Math.min(backoffMs * 2, MAX_RETRY_MS);
			};

			// A failed connection also closes, so the retry lives in onclose alone.
			next.onerror = () => {};
		}

		connect();

		return () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			if (debounce !== undefined) clearTimeout(debounce);
			socket?.close();
		};
	}, [client, workspaceId, projectId]);
}
