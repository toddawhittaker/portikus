/**
 * The browser end of the project events socket (SPEC.md §11.4, §25.1). One
 * socket per open project tells the browser what changed on disk, so the
 * tree, the open files and the Git status are refetched within a couple of
 * seconds of a change made in a terminal or by a coding agent, and nothing
 * polls.
 */
import {
	type BrowserOpenRequest,
	BrowserOpenRequest as BrowserOpenRequestSchema,
	FsEvent,
	WatchLimited,
} from "@portikus/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { wsUrl } from "../api/ws.js";
import { parentOf } from "./paths.js";
import { fileKeys } from "./queries.js";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
/** A socket that lived at least this long counts as a working connection. */
const HEALTHY_MS = 5_000;
/**
 * Close codes that mean the server refused us: the session is gone, the
 * project is gone, or the request was rejected. Retrying cannot help.
 */
const REFUSED_CODES = new Set([4401, 4404, 1008]);
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

/**
 * Fold a batch of frames into the one set of refetches they need.
 *
 * Any change on disk can change Git status, not only a write inside `.git`:
 * editing a tracked file makes it modified, and creating one makes it
 * untracked (SPEC.md §12.3). So any batch that carries paths, or that says
 * it touched Git, or that overflowed, refetches the status.
 */
export function invalidationsFor(frames: readonly FsEvent[]): Invalidations {
	const trees = new Set<string>();
	const files = new Set<string>();
	let git = false;
	let all = false;
	for (const frame of frames) {
		if (frame.git || frame.truncated || frame.paths.length > 0) git = true;
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
		// Session review uses the same Git shape against another object id.
		void client.invalidateQueries({
			queryKey: ["git-status", workspaceId, projectId, "baseline"],
		});
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
					(key[0] === "files" ||
						key[0] === "file" ||
						key[0] === "git-diff" ||
						key[0] === "git-status") &&
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

/** Refetch everything the project shows: tree, open files, Git status. */
function refreshAll(client: QueryClient, workspaceId: string, projectId: string): void {
	applyInvalidations(client, workspaceId, projectId, {
		git: true,
		trees: [],
		files: [],
		all: true,
	});
}

/**
 * Keep one events socket open while the project is on screen. A socket that
 * drops is opened again with a backoff, because a workspace that is
 * restarting should not be hammered, and a socket the server refuses is not
 * opened again at all. A project too large to watch is not reconnected; it
 * refreshes when the window regains focus and after the student's own
 * actions instead, and `limited` says so (SPEC.md §11.4).
 */
export function useProjectEvents(
	workspaceId: string,
	projectId: string,
	onBrowserOpen?: (request: BrowserOpenRequest) => void,
): { limited: boolean } {
	const client = useQueryClient();
	const onBrowserOpenRef = useRef(onBrowserOpen);
	onBrowserOpenRef.current = onBrowserOpen;
	const [limited, setLimited] = useState(false);

	useEffect(() => {
		setLimited(false);
		let limitedHere = false;
		let stopFallback: (() => void) | undefined;
		let stopped = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let debounce: ReturnType<typeof setTimeout> | undefined;
		let backoffMs = FIRST_RETRY_MS;
		let pending: FsEvent[] = [];
		let everOpened = false;

		function flush(): void {
			debounce = undefined;
			const frames = pending;
			pending = [];
			if (frames.length === 0) return;
			applyInvalidations(client, workspaceId, projectId, invalidationsFor(frames));
		}

		function startFallback(): void {
			const refresh = () => refreshAll(client, workspaceId, projectId);
			window.addEventListener("focus", refresh);
			// The student's own file actions change the tree, and nothing else says so.
			const actionKey = JSON.stringify(fileKeys.actions(workspaceId, projectId));
			const unsubscribe = client.getMutationCache().subscribe((event) => {
				if (event.type !== "updated" || event.action.type !== "success") return;
				if (JSON.stringify(event.mutation.options.mutationKey) === actionKey) refresh();
			});
			stopFallback = () => {
				window.removeEventListener("focus", refresh);
				unsubscribe();
			};
		}

		function connect(): void {
			if (stopped) return;
			const next = new WebSocket(
				wsUrl(`/workspaces/${workspaceId}/projects/${projectId}/events`),
			);
			socket = next;
			const startedAt = Date.now();

			next.onopen = () => {
				if (everOpened) {
					// Frames sent while the socket was down are lost, so everything
					// this project shows is refetched once (SPEC.md §11.4).
					refreshAll(client, workspaceId, projectId);
				}
				everOpened = true;
			};

			next.onmessage = (event: MessageEvent) => {
				let frame: unknown;
				try {
					frame = JSON.parse(String(event.data));
				} catch {
					return;
				}
				// The same socket carries filesystem batches and browser-open
				// requests. A frame that is neither is ignored.
				const browser = BrowserOpenRequestSchema.safeParse(frame);
				if (browser.success) {
					onBrowserOpenRef.current?.(browser.data);
					return;
				}
				if (WatchLimited.safeParse(frame).success) {
					if (limitedHere) return;
					limitedHere = true;
					setLimited(true);
					startFallback();
					// The agent has closed its watcher, so this socket carries nothing more.
					next.close();
					return;
				}
				const parsed = FsEvent.safeParse(frame);
				if (!parsed.success) return;
				pending.push(parsed.data);
				if (debounce === undefined)
					debounce = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
			};

			next.onclose = (event: CloseEvent) => {
				if (stopped) return;
				if (limitedHere || REFUSED_CODES.has(event.code)) return;
				const wait = backoffMs;
				// A socket that died young is a failing connection, so wait longer
				// next time; one that worked for a while starts over from the top.
				if (Date.now() - startedAt < HEALTHY_MS) {
					backoffMs = Math.min(backoffMs * 2, MAX_RETRY_MS);
				} else {
					backoffMs = FIRST_RETRY_MS;
				}
				retry = setTimeout(connect, wait);
			};

			// A failed connection also closes, so the retry lives in onclose alone.
			next.onerror = () => {};
		}

		connect();

		return () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			if (debounce !== undefined) clearTimeout(debounce);
			stopFallback?.();
			socket?.close();
		};
	}, [client, workspaceId, projectId]);

	return { limited };
}
