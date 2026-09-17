/**
 * Loading and saving one project's layout (SPEC.md §7.5). The layout is read
 * once on mount and written back at most once a second after a structural
 * change; last write wins. Active tab changes are local, so they never
 * trigger a save.
 */
import { ProjectLayout } from "@portikus/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { request } from "../api/request.js";
import type { LayoutStore } from "./store.js";

const SAVE_DEBOUNCE_MS = 1_000;

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
			if (!state.dirty || timer !== undefined) return;
			timer = setTimeout(save, SAVE_DEBOUNCE_MS);
		});

		function flush() {
			if (timer !== undefined) clearTimeout(timer);
			save();
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
