/**
 * The zoom of each terminal and chat pane (SPEC.md §13.1). This tab's
 * sessionStorage keeps it, so a pane that splits or moves, and so mounts
 * again, or a workspace the student leaves and comes back to, still has it.
 * It is browser-local and never sent to the server (SPEC.md §7.5).
 */
import { useCallback, useContext, useState } from "react";
import { clampZoom, DEFAULT_ZOOM } from "../editor/zoom.js";
import { LayoutStoreContext } from "./store.js";

/** Terminal ids are unique across projects, so one key serves them all. */
const PANE_ZOOM_KEY = "portikus.paneZoom";

function sessionPaneZooms(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(sessionStorage.getItem(PANE_ZOOM_KEY) ?? "{}");
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// Refused or corrupt storage: the pane starts at 100%.
		return {};
	}
}

function readSessionPaneZoom(terminalId: string): number | undefined {
	const value = sessionPaneZooms()[terminalId];
	return typeof value === "number" ? clampZoom(value) : undefined;
}

function writeSessionPaneZoom(terminalId: string, percent: number): void {
	try {
		const zooms = { ...sessionPaneZooms(), [terminalId]: percent };
		sessionStorage.setItem(PANE_ZOOM_KEY, JSON.stringify(zooms));
	} catch {
		// Refused storage only costs the zoom on leaving the workspace.
	}
}

/**
 * The zoom of one terminal or chat pane, read from sessionStorage when the
 * pane mounts. Null outside a workspace, where the pane offers no zoom.
 */
export function usePaneZoom(
	terminalId: string,
): [number, (percent: number) => void] | null {
	const inWorkspace = useContext(LayoutStoreContext) !== null;
	const [zoom, setLocal] = useState(
		() => readSessionPaneZoom(terminalId) ?? DEFAULT_ZOOM,
	);
	const set = useCallback(
		(percent: number) => {
			setLocal(percent);
			writeSessionPaneZoom(terminalId, percent);
		},
		[terminalId],
	);
	return inWorkspace ? [zoom, set] : null;
}
