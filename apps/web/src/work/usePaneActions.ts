/**
 * The layout actions a pane's menu and the tab strip share, for any area that
 * lays panes out in tabs: workspace terminals and root shells (SPEC.md §9.3,
 * §25.8). The caller owns what a pane is and how it ends.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { type TabItem, tabDomId } from "@portikus/ui";
import { type RefObject, useRef } from "react";
import type { LayoutStore } from "../layout/store.js";
import { paneIds } from "../layout/tree.js";
import { moveIntoTargets } from "./moveInto.js";
import { focusAfterPane, tabAfterClose } from "./paneFocus.js";

export interface PaneActionsOptions {
	store: LayoutStore;
	layout: ProjectLayout;
	activeTabId: string | null;
	/** The element holding the tab strip's `role="tab"` buttons. */
	strip: RefObject<HTMLElement | null>;
	/** The tabs as the strip names them. */
	items: readonly TabItem[];
	/** The control that opens a new pane, where the keyboard goes when no pane is left. */
	newControl: () => HTMLElement | null;
	/** End every pane in a tab. */
	closeTab: (tabId: string) => void;
}

export function usePaneActions({
	store,
	layout,
	activeTabId,
	strip,
	items,
	newControl,
	closeTab,
}: PaneActionsOptions) {
	// The tab a confirmed tab close leaves active, for the dialog to return
	// focus to; undefined until confirmed, so Cancel returns focus as usual.
	const tabAfterConfirm = useRef<string | null | undefined>(undefined);

	/** Move the keyboard to the next pane in the tab, or to the New control. */
	function moveFocusOff(paneId: string) {
		const next = focusAfterPane(layout, paneId, newControl());
		if (next) store.getState().setFocused(next);
	}

	/**
	 * Close a tab the dialog confirmed. The next tab shows first, since a
	 * workspace terminal's pane goes only after a round trip.
	 */
	function confirmCloseTab(tabId: string) {
		const next = tabAfterClose(layout, tabId, store.getState().tabHistory);
		tabAfterConfirm.current = next;
		if (next) store.getState().setActive(next);
		closeTab(tabId);
	}

	function focusAfterCloseDialog(): HTMLElement | null {
		const next = tabAfterConfirm.current;
		tabAfterConfirm.current = undefined;
		if (next === undefined) return null;
		return next ? document.getElementById(tabDomId(next)) : newControl();
	}

	/** Alt+Shift+Q leaves the terminal for the tab strip (DESIGN.md). */
	function leaveTerminal() {
		const tabs = strip.current?.querySelectorAll<HTMLElement>('[role="tab"]');
		if (!tabs) return;
		const index = layout.tabs.findIndex((tab) => tab.id === activeTabId);
		(tabs[index < 0 ? 0 : index] ?? tabs[0])?.focus();
	}

	/** Give a pane a tab of its own after its current one. */
	function moveToNewTab(paneId: string) {
		const from = layout.tabs.findIndex((tab) => paneIds(tab.root).includes(paneId));
		store.getState().moveLeafToNewTab(paneId, from + 1);
		store.getState().setFocused(paneId);
	}

	/** The other tabs a pane can join, under the names the tab strip shows. */
	function moveTargetsFor(paneId: string) {
		return moveIntoTargets(layout, paneId).map((target) => ({
			tabId: target.tabId,
			label: items.find((item) => item.id === target.tabId)?.label ?? "Tab",
		}));
	}

	/** Put a pane into another tab's split, as dropping it there would. */
	function moveInto(paneId: string, tabId: string) {
		const target = moveIntoTargets(layout, paneId).find(
			(candidate) => candidate.tabId === tabId,
		);
		if (!target) return;
		store.getState().moveLeaf(tabId, paneId, target.paneId, target.edge);
		store.getState().setFocused(paneId);
	}

	return {
		moveFocusOff,
		confirmCloseTab,
		focusAfterCloseDialog,
		leaveTerminal,
		moveToNewTab,
		moveTargetsFor,
		moveInto,
	};
}
