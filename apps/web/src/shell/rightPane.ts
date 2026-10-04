/**
 * Which surface the right pane is showing (SPEC.md §8.4, §18.1, §18.2, §18.3).
 * The
 * work area needs to switch it too, because a Preview tab offers a link to
 * the Running surface (BROWSER-HANDLING.md §12), so the choice is held by
 * the workspace screen rather than by the pane itself. Monitor's sort lives
 * here as well, so a notice can open Monitor already sorted (SPEC.md §18.3).
 */
import { createContext, useContext, useMemo, useState } from "react";
import {
	DEFAULT_PROCESS_SORT,
	type ProcessColumn,
	type ProcessSort,
} from "../monitor/sort.js";

export type RightPane = "files" | "checks" | "running" | "monitor";

export interface RightPaneApi {
	pane: RightPane;
	show: (pane: RightPane) => void;
	monitorSort: ProcessSort;
	setMonitorSort: (sort: ProcessSort) => void;
	/** Set when a button elsewhere opened Monitor; the pane focuses the Monitor tab and clears it. */
	monitorFocus: boolean;
	setMonitorFocus: (focus: boolean) => void;
}

/** Null outside a workspace screen, the way the layout store context is. */
export const RightPaneContext = createContext<RightPaneApi | null>(null);

/** The screen's own state, which WorkspacePage provides through the context. */
export function useRightPaneStore(): RightPaneApi {
	const [pane, show] = useState<RightPane>("files");
	const [monitorSort, setMonitorSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT);
	const [monitorFocus, setMonitorFocus] = useState(false);
	// One object per change, so context readers re-render only when it moves.
	return useMemo(
		() => ({ pane, show, monitorSort, setMonitorSort, monitorFocus, setMonitorFocus }),
		[pane, monitorSort, monitorFocus],
	);
}

/**
 * The shared choice, or one of this component's own when it is rendered
 * outside a workspace screen.
 */
export function useRightPaneState(): RightPaneApi {
	const shared = useContext(RightPaneContext);
	const local = useRightPaneStore();
	return shared ?? local;
}

/** Ask for a surface from elsewhere in the screen; nothing happens alone. */
export function useShowRightPane(): (pane: RightPane) => void {
	const shared = useContext(RightPaneContext);
	return shared?.show ?? (() => {});
}

/**
 * Open Monitor sorted by one column, largest first, and move focus to it, so
 * a keyboard or screen reader user lands where the pane changed.
 */
export function showMonitor(api: RightPaneApi, column: ProcessColumn): void {
	api.setMonitorSort({ column, direction: "descending" });
	api.setMonitorFocus(true);
	api.show("monitor");
}

/** `showMonitor` bound to the screen's right pane; does nothing outside one. */
export function useShowMonitor(): (column: ProcessColumn) => void {
	const shared = useContext(RightPaneContext);
	return (column) => {
		if (shared) showMonitor(shared, column);
	};
}
