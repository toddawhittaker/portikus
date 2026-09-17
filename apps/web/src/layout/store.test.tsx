import { expect, test } from "vitest";
import { createLayoutStore } from "./store";
import { layoutTerminalIds, leafIds } from "./tree";

function store() {
	let next = 0;
	return createLayoutStore(() => `tab${++next}`);
}

test("adding a tab activates it and marks the layout dirty", () => {
	const layout = store();
	layout.getState().addTab("a");
	expect(layout.getState().activeTabId).toBe("tab1");
	expect(layout.getState().dirty).toBe(true);
	layout.getState().clearDirty();
	layout.getState().addTab("b");
	expect(layout.getState().activeTabId).toBe("tab2");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a", "b"]);
});

test("splitting adds the new terminal to the same tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().splitLeaf("a", "row", "b");
	expect(layout.getState().layout.tabs).toHaveLength(1);
	expect(
		leafIds(layout.getState().layout.tabs[0]?.root ?? { type: "leaf", terminalId: "" }),
	).toEqual(["a", "b"]);
});

test("removing the last pane of the active tab moves the active tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().addTab("b");
	layout.getState().removeLeaf("b");
	expect(layout.getState().activeTabId).toBe("tab1");
	layout.getState().removeLeaf("a");
	expect(layout.getState().activeTabId).toBeNull();
});

test("loading a saved layout clears dirty", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout
		.getState()
		.load({ tabs: [{ id: "saved", root: { type: "leaf", terminalId: "z" } }] });
	expect(layout.getState().dirty).toBe(false);
	expect(layout.getState().activeTabId).toBe("saved");
});

test("the active tab and the focused pane are not structural changes", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().addTab("b");
	layout.getState().clearDirty();
	layout.getState().setActive("tab1");
	layout.getState().setFocused("a");
	expect(layout.getState().dirty).toBe(false);
	expect(layout.getState().activeTabId).toBe("tab1");
	expect(layout.getState().focusedTerminalId).toBe("a");
});

test("moving and resizing go through the tree and mark the layout dirty", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().addTab("b");
	layout.getState().moveTab(1, 0);
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual(["tab2", "tab1"]);
	layout.getState().splitLeaf("a", "row", "c");
	layout.getState().clearDirty();
	layout.getState().resize("tab1", [], [70, 30]);
	expect(layout.getState().dirty).toBe(true);
});

test("reconcile adds tabs for new terminals and drops panes that are gone", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().reconcile(["a", "b"]);
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a", "b"]);
	layout.getState().reconcile(["b"]);
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["b"]);
});

test("reconcile with no change leaves the layout clean", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().clearDirty();
	layout.getState().reconcile(["a"]);
	expect(layout.getState().dirty).toBe(false);
});

test("replacing a pane keeps one tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().replaceLeaf("a", "b");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["b"]);
});
