/**
 * The menu way to drop a pane into another tab, the click alternative to
 * dragging it there (SPEC.md §9.3, §25.8, WCAG 2.5.7). It lands where a drag
 * onto the right edge of that tab's last terminal would.
 */
import type { ProjectLayout } from "@portikus/contracts";
import type { LayoutState } from "../layout/store.js";
import {
	type DropEdge,
	fileTabId,
	moveLeaf,
	openFile,
	paneIds,
	tabOfPane,
} from "../layout/tree.js";

export interface MoveIntoTarget {
	tabId: string;
	/** The pane the moved one lands beside: a terminal id or a file's pane id. */
	paneId: string;
	edge: DropEdge;
}

/**
 * Every other tab that can take this pane, a terminal or a file, as a split,
 * in tab order. A preview tab holds no panes, and a tab already at the depth
 * limit refuses the move, so neither is offered.
 */
export function moveIntoTargets(
	layout: ProjectLayout,
	paneId: string,
): MoveIntoTarget[] {
	return layout.tabs.flatMap((tab) => {
		const ids = paneIds(tab.root);
		const last = ids.at(-1);
		if (last === undefined || ids.includes(paneId)) return [];
		const target: MoveIntoTarget = { tabId: tab.id, paneId: last, edge: "right" };
		// The id is never used: only whether the move is allowed matters here.
		const moved = moveLeaf(layout, tab.id, paneId, last, target.edge, () => "probe");
		return moved === layout ? [] : [target];
	});
}

/**
 * Where a file dragged from the tree onto pane `overPaneId` lands (SPEC.md
 * §9.3): beside that pane on `edge`, whether the file is new to the layout
 * or already open elsewhere. The centre, the file's own pane, and a split
 * past the depth limit take no drop.
 */
export function fileDropTarget(
	layout: ProjectLayout,
	path: string,
	overPaneId: string,
	edge: DropEdge,
): MoveIntoTarget | null {
	if (edge === "center") return null;
	const tabId = tabOfPane(layout, overPaneId);
	if (tabId === null) return null;
	const opened = openFile(layout, path).layout;
	const moved = moveLeaf(
		opened,
		tabId,
		fileTabId(path),
		overPaneId,
		edge,
		() => "probe",
	);
	return moved === opened ? null : { tabId, paneId: overPaneId, edge };
}

/**
 * Drop a file dragged from the tree beside `target` (SPEC.md §9.3). A file
 * already open only moves, so its pane keeps its Diff view and baseline;
 * opening it again would reset both to the editor.
 */
export function dropTreeFile(state: LayoutState, path: string, target: MoveIntoTarget) {
	const pane = fileTabId(path);
	if (tabOfPane(state.layout, pane) === null) state.openFile(path);
	state.moveLeaf(target.tabId, pane, target.paneId, target.edge);
	state.setFocused(pane);
}
