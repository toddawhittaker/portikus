/**
 * The menu way to drop a pane into another tab, the click alternative to
 * dragging it there (SPEC.md §9.3, §25.8, WCAG 2.5.7). It lands where a drag
 * onto the right edge of that tab's last terminal would.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { type DropEdge, moveLeaf, terminalIds } from "../layout/tree.js";

export interface MoveIntoTarget {
	tabId: string;
	/** The pane the moved one lands beside. */
	terminalId: string;
	edge: DropEdge;
}

/**
 * Every other tab that can take this pane as a split, in tab order. A file or
 * preview tab holds no terminals, and a tab already at the depth limit
 * refuses the move, so neither is offered.
 */
export function moveIntoTargets(
	layout: ProjectLayout,
	terminalId: string,
): MoveIntoTarget[] {
	return layout.tabs.flatMap((tab) => {
		const ids = terminalIds(tab.root);
		const last = ids.at(-1);
		if (last === undefined || ids.includes(terminalId)) return [];
		const target: MoveIntoTarget = { tabId: tab.id, terminalId: last, edge: "right" };
		const moved = moveLeaf(layout, tab.id, terminalId, last, target.edge);
		return moved === layout ? [] : [target];
	});
}
