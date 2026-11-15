/**
 * The hooks that give each pane its kept zoom (SPEC.md §13.1); the keeping
 * itself is in paneZoomKeeper.ts.
 */
import { useCallback, useContext, useState, useSyncExternalStore } from "react";
import { DEFAULT_ZOOM } from "../editor/zoom.js";
import {
	fileZoomKey,
	readPaneZoom,
	subscribePaneZooms,
	terminalZoomKey,
	writePaneZoom,
} from "./paneZoomKeeper.js";
import { LayoutStoreContext } from "./store.js";

/**
 * The zoom kept for `key`, and a way to change it. The settings query seeds
 * the kept zooms when it resolves, which is before the workspace first
 * paints, and a pane drawn sooner takes them up then. A null key keeps the
 * zoom in this component only.
 */
export function usePersistedZoom(
	key: string | null,
): [number, (percent: number) => void] {
	const [own, setOwn] = useState(DEFAULT_ZOOM);
	const held = useSyncExternalStore(subscribePaneZooms, () =>
		key === null ? undefined : readPaneZoom(key),
	);
	const set = useCallback(
		(percent: number) => {
			if (key === null) setOwn(percent);
			else writePaneZoom(key, percent);
		},
		[key],
	);
	return [key === null ? own : (held ?? DEFAULT_ZOOM), set];
}

/**
 * The zoom of one terminal or chat pane. Null outside a workspace, where the
 * pane offers no zoom.
 */
export function usePaneZoom(
	terminalId: string,
): [number, (percent: number) => void] | null {
	const store = useContext(LayoutStoreContext);
	const projectId = store?.getState().projectId ?? null;
	const zoom = usePersistedZoom(
		projectId === null ? null : terminalZoomKey(projectId, terminalId),
	);
	return store ? zoom : null;
}

/**
 * The editor zoom of one open file, kept by its project and path. The editor
 * and the diff of one file both read it, so a change in either shows in the
 * other. A file tab rendered outside a project keeps its own zoom.
 */
export function useEditorZoom(path: string): [number, (percent: number) => void] {
	const projectId = useContext(LayoutStoreContext)?.getState().projectId ?? null;
	return usePersistedZoom(projectId === null ? null : fileZoomKey(projectId, path));
}
