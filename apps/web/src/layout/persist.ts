/**
 * Loading and saving one project's layout (SPEC.md §7.5). The layout is read
 * once on mount and written back at most once a second after a structural
 * change; last write wins. The selected tab and each open file's cursor and
 * scroll position are browser-local, so they go to localStorage rather than
 * to the server (local.ts, issue #161).
 */
import { ProjectLayout } from "@portikus/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { request } from "../api/request.js";
import { readLocalLayout, writeLocalLayout } from "./local.js";
import type { LayoutStore } from "./store.js";

const SAVE_DEBOUNCE_MS = 1_000;
const LOCAL_SAVE_DEBOUNCE_MS = 300;

function layoutUrl(workspaceId: string, projectId: string): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/layout`;
}

/**
 * Returns true once the saved layout has been read (or found to be missing),
 * so the caller does not reconcile an empty layout over a saved one.
 */
export function useLayoutPersistence(
	workspaceId: string,
	projectId: string,
	store: LayoutStore,
	onSessionEnded: () => void,
): boolean {
	const [loaded, setLoaded] = useState(false);
	const sessionEnded = useRef(onSessionEnded);
	sessionEnded.current = onSessionEnded;

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		const url = layoutUrl(workspaceId, projectId);

		// Put back the selected tab and the editor view states before the saved
		// layout arrives, so its load keeps the tab this browser was on.
		const local = readLocalLayout(projectId);
		if (local) store.getState().restoreLocal(local);

		async function load() {
			try {
				// A project with no saved layout answers 204, which `request`
				// turns into undefined.
				const saved = (await request(ProjectLayout, url)) as ProjectLayout | undefined;
				if (cancelled) return;
				if (saved) store.getState().load(saved);
			} catch (error) {
				if (error instanceof Error && error.name === "SessionEndedError") {
					sessionEnded.current();
					return;
				}
				// A layout we could not read is not worth an error screen: the
				// user gets the tabs reconciled from the terminal list instead.
			} finally {
				if (!cancelled) setLoaded(true);
			}
		}
		void load();

		let timer: ReturnType<typeof setTimeout> | undefined;
		let localTimer: ReturnType<typeof setTimeout> | undefined;

		/** Keep only the view states of the file tabs that are still open. */
		function saveLocal() {
			localTimer = undefined;
			const state = store.getState();
			// Before the saved layout arrives there are no tabs to compare
			// against, and pruning then would throw away what was remembered.
			if (state.layout.tabs.length === 0) return;
			const open = new Set(
				state.layout.tabs.flatMap((tab) =>
					tab.root.type === "file" ? [tab.root.path] : [],
				),
			);
			const viewStates: Record<string, unknown> = {};
			for (const [path, viewState] of Object.entries(state.viewStates)) {
				if (open.has(path)) viewStates[path] = viewState;
			}
			writeLocalLayout(projectId, { activeTabId: state.activeTabId, viewStates });
		}

		function save() {
			timer = undefined;
			const state = store.getState();
			if (!state.dirty) return;
			state.clearDirty();
			void request(z.unknown(), url, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(state.layout),
			}).catch(() => {
				// A failed save is retried by the next change; the layout is a
				// convenience, not the user's work.
			});
		}

		const unsubscribe = store.subscribe((state) => {
			if (localTimer === undefined) {
				localTimer = setTimeout(saveLocal, LOCAL_SAVE_DEBOUNCE_MS);
			}
			if (!state.dirty || timer !== undefined) return;
			timer = setTimeout(save, SAVE_DEBOUNCE_MS);
		});

		function flush() {
			if (timer !== undefined) clearTimeout(timer);
			if (localTimer !== undefined) clearTimeout(localTimer);
			save();
			saveLocal();
		}
		window.addEventListener("pagehide", flush);

		return () => {
			cancelled = true;
			unsubscribe();
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, [workspaceId, projectId, store]);

	return loaded;
}
