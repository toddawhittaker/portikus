/**
 * Loading and saving one project's layout (SPEC.md §7.5). The layout is read
 * on mount and written back at most once a second after a structural change.
 * Each save names the version it was based on; a stale one is refused, and
 * the browser then takes the server's layout. A save from another browser is
 * announced on the workspace socket, and this browser loads it. The selected
 * tab and each open file's cursor and scroll position are browser-local, so
 * they go to localStorage rather than to the server (local.ts).
 */
import { ProjectLayout } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, toApiError } from "../api/request.js";
import { sessionEnded } from "../api/sessionEnded.js";
import { terminalsKey } from "../terminal/useTerminals.js";
import { onLayoutAnnounced } from "./announcements.js";
import { readLocalLayout, writeLocalLayout } from "./local.js";
import type { LayoutStore } from "./store.js";
import { emptyLayout, filePaths } from "./tree.js";

const SAVE_DEBOUNCE_MS = 1_000;
const LOCAL_SAVE_DEBOUNCE_MS = 300;

function layoutUrl(workspaceId: string, projectId: string): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/layout`;
}

/** The version an ETag header names, or null. */
function versionOf(response: Response): number | null {
	const match = /^"(\d+)"$/.exec(response.headers.get("etag") ?? "");
	return match ? Number(match[1]) : null;
}

/** The saved layout (undefined when there is none) and its version. */
async function readLayout(
	url: string,
): Promise<{ layout: ProjectLayout | undefined; version: number | null }> {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) throw await toApiError(response);
	const version = versionOf(response);
	if (response.status === 204) return { layout: undefined, version };
	return { layout: ProjectLayout.parse(await response.json()), version };
}

/**
 * Returns true once the saved layout has been read (or found to be missing),
 * so the caller does not reconcile an empty layout over a saved one.
 */
export function useLayoutPersistence(
	workspaceId: string,
	projectId: string,
	store: LayoutStore,
): boolean {
	// The URL whose layout is in, so a switch never reports the old one as loaded.
	const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
	const toast = useToast();
	const queryClient = useQueryClient();

	useEffect(() => {
		let cancelled = false;
		let loaded = false;
		let saving: Promise<void> | null = null;
		// The newest version announced for this project.
		let announced = -1;
		const url = layoutUrl(workspaceId, projectId);

		// Put back the selected tab and the editor view states before the saved
		// layout arrives, so its load keeps the tab this browser was on.
		const local = readLocalLayout(projectId);
		if (local) store.getState().restoreLocal(local);

		function failed(error: unknown) {
			if (error instanceof Error && error.name === "SessionEndedError") sessionEnded();
			// Other failures are not worth an error screen: the layout is a
			// convenience, and the next announcement or change tries again.
		}

		/** Take the server's layout when it is newer than the one here. */
		async function loadRemote() {
			try {
				const { layout, version } = await readLayout(url);
				if (cancelled || version === null) return;
				store.getState().loadRemote(layout ?? emptyLayout(), version);
				// Its panes may name terminals this browser has not listed yet.
				void queryClient.invalidateQueries({
					queryKey: terminalsKey(workspaceId, projectId),
				});
			} catch (error) {
				failed(error);
			}
		}

		/** Our own save's echo is not newer than what we hold, so it is ignored. */
		function catchUp() {
			if (!loaded || saving !== null || cancelled) return;
			if (announced > (store.getState().version ?? -1)) void loadRemote();
		}

		async function load() {
			try {
				const { layout, version } = await readLayout(url);
				if (cancelled) return;
				if (layout) store.getState().load(layout, version ?? undefined);
				else if (version !== null) store.getState().setVersion(version);
			} catch (error) {
				failed(error);
			} finally {
				if (!cancelled) {
					loaded = true;
					setLoadedUrl(url);
					catchUp();
				}
			}
		}
		void load();

		const stopListening = onLayoutAnnounced(workspaceId, projectId, (version) => {
			announced = Math.max(announced, version);
			catchUp();
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		let localTimer: ReturnType<typeof setTimeout> | undefined;
		// Every later change retries the save, so the limit is told only once.
		let limitShown = false;

		/** Keep only the view states of the files still open, in a tab or a split. */
		function saveLocal() {
			localTimer = undefined;
			const state = store.getState();
			// Before the saved layout arrives there are no tabs to compare
			// against, and pruning then would throw away what was remembered.
			if (state.layout.tabs.length === 0) return;
			const open = new Set(state.layout.tabs.flatMap((tab) => filePaths(tab.root)));
			const viewStates: Record<string, unknown> = {};
			for (const [path, viewState] of Object.entries(state.viewStates)) {
				if (open.has(path)) viewStates[path] = viewState;
			}
			writeLocalLayout(projectId, { activeTabId: state.activeTabId, viewStates });
		}

		async function put(): Promise<void> {
			const state = store.getState();
			state.clearDirty();
			try {
				const response = await fetch(url, {
					method: "PUT",
					credentials: "same-origin",
					headers: {
						"content-type": "application/json",
						"if-match": `"${state.version ?? 0}"`,
					},
					body: JSON.stringify(state.layout),
				});
				if (!response.ok) throw await toApiError(response);
				const version = versionOf(response);
				if (version !== null) store.getState().setVersion(version);
			} catch (error) {
				if (error instanceof ApiError && error.code === "LAYOUT_CHANGED") {
					// Another browser saved first; its layout wins (SPEC.md §7.5).
					if (!cancelled) await loadRemote();
					return;
				}
				// Other failures are retried by the next change; the layout is a
				// convenience, not the user's work. Only the size limit needs
				// the student to act.
				if (error instanceof ApiError && error.code === "LAYOUT_LIMIT" && !limitShown) {
					limitShown = true;
					toast.show({ tone: "warning", title: error.message });
				}
				failed(error);
			}
		}

		function save() {
			timer = undefined;
			if (!store.getState().dirty) return;
			// One save at a time, so each names the version the last one made.
			if (saving !== null) {
				if (cancelled) {
					// Leaving the project: send the last change after the one in flight.
					void saving.then(() => (store.getState().dirty ? put() : undefined));
				} else {
					timer = setTimeout(save, SAVE_DEBOUNCE_MS);
				}
				return;
			}
			saving = put().finally(() => {
				saving = null;
				catchUp();
			});
		}

		const unsubscribe = store.subscribe((state) => {
			if (localTimer === undefined) {
				localTimer = setTimeout(saveLocal, LOCAL_SAVE_DEBOUNCE_MS);
			}
			if (!state.dirty || timer !== undefined) return;
			timer = setTimeout(save, SAVE_DEBOUNCE_MS);
		});

		// A drag holds any remote layout until it ends (SPEC.md §7.5). Pane and
		// tab drags and split resizes run on pointer events; a file dragged
		// from the tree is a native drag, which cancels the pointer.
		let pointerDown = false;
		let nativeDrag = false;
		function dragState() {
			const dragging = pointerDown || nativeDrag;
			if (store.getState().dragging !== dragging)
				store.getState().setDragging(dragging);
		}
		const onPointerDown = () => {
			pointerDown = true;
			dragState();
		};
		const onPointerUp = () => {
			pointerDown = false;
			dragState();
		};
		const onDragStart = () => {
			nativeDrag = true;
			dragState();
		};
		const onDragEnd = () => {
			nativeDrag = false;
			pointerDown = false;
			dragState();
		};
		const pointerEvents: Array<[string, () => void]> = [
			["pointerdown", onPointerDown],
			["pointerup", onPointerUp],
			["pointercancel", onPointerUp],
			["dragstart", onDragStart],
			["dragend", onDragEnd],
			["drop", onDragEnd],
		];
		for (const [name, listener] of pointerEvents) {
			document.addEventListener(name, listener, true);
		}

		function flush() {
			if (timer !== undefined) clearTimeout(timer);
			if (localTimer !== undefined) clearTimeout(localTimer);
			timer = undefined;
			save();
			saveLocal();
		}
		window.addEventListener("pagehide", flush);

		return () => {
			cancelled = true;
			stopListening();
			unsubscribe();
			for (const [name, listener] of pointerEvents) {
				document.removeEventListener(name, listener, true);
			}
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, [workspaceId, projectId, store, toast, queryClient]);

	return loadedUrl === layoutUrl(workspaceId, projectId);
}
