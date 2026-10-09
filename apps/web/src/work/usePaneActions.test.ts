import { tabDomId } from "@portikus/ui";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createLayoutStore } from "../layout/store.js";
import { usePaneActions } from "./usePaneActions.js";

afterEach(() => document.body.replaceChildren());

/** A store with one tab per id, the last one active. */
function storeWith(...ids: string[]) {
	const store = createLayoutStore();
	for (const id of ids) store.getState().addTab(id);
	return store;
}

function actions(
	store: ReturnType<typeof createLayoutStore>,
	closeTab: (tabId: string) => void,
	newControl: HTMLElement | null = null,
) {
	const state = store.getState();
	return renderHook(() =>
		usePaneActions({
			store,
			layout: state.layout,
			activeTabId: state.activeTabId,
			strip: { current: null },
			items: state.layout.tabs.map((tab) => ({
				id: tab.id,
				kind: "terminal" as const,
				label: `Tab ${tab.id}`,
			})),
			newControl: () => newControl,
			closeTab,
		}),
	).result.current;
}

test("a confirmed tab close shows the next tab before closing, and the dialog returns focus to it", () => {
	const store = storeWith("a", "b");
	const activeAtClose = vi.fn(() => store.getState().activeTabId);
	const panes = actions(store, activeAtClose);
	const tab = document.createElement("button");
	tab.id = tabDomId("a");
	document.body.append(tab);

	panes.confirmCloseTab("b");
	expect(activeAtClose).toHaveBeenCalledWith("b");
	expect(activeAtClose.mock.results[0]?.value).toBe("a");
	expect(panes.focusAfterCloseDialog()).toBe(tab);
	// Read once: a later Cancel returns focus as the dialog would.
	expect(panes.focusAfterCloseDialog()).toBeNull();
});

test("closing the last tab returns focus to the New control", () => {
	const store = storeWith("a");
	const button = document.createElement("button");
	const panes = actions(store, () => {}, button);
	panes.confirmCloseTab("a");
	expect(panes.focusAfterCloseDialog()).toBe(button);
});

test("a pane moves into another tab, or to a new tab after its own, and keeps the keyboard", () => {
	const store = storeWith("a", "b");
	let panes = actions(store, () => {});
	expect(panes.moveTargetsFor("b")).toEqual([{ tabId: "a", label: "Tab a" }]);

	panes.moveInto("b", "a");
	expect(store.getState().layout.tabs).toHaveLength(1);
	expect(store.getState().focusedPaneId).toBe("b");

	panes = actions(store, () => {});
	panes.moveToNewTab("b");
	expect(store.getState().layout.tabs).toHaveLength(2);
	expect(store.getState().focusedPaneId).toBe("b");
});
