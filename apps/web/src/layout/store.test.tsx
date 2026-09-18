import { MAX_LAYOUT_TABS } from "@portikus/contracts";
import { expect, test } from "vitest";
import { createLayoutStore } from "./store";
import { layoutTerminalIds, terminalIds } from "./tree";

function store() {
	return createLayoutStore();
}

test("adding a tab activates it and marks the layout dirty", () => {
	const layout = store();
	layout.getState().addTab("a");
	expect(layout.getState().activeTabId).toBe("a");
	expect(layout.getState().dirty).toBe(true);
	layout.getState().clearDirty();
	layout.getState().addTab("b");
	expect(layout.getState().activeTabId).toBe("b");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a", "b"]);
});

test("splitting adds the new terminal to the same tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().splitLeaf("a", "row", "b");
	expect(layout.getState().layout.tabs).toHaveLength(1);
	expect(
		terminalIds(
			layout.getState().layout.tabs[0]?.root ?? { type: "leaf", terminalId: "" },
		),
	).toEqual(["a", "b"]);
});

test("removing the last pane of the active tab moves the active tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().addTab("b");
	layout.getState().removeLeaf("b");
	expect(layout.getState().activeTabId).toBe("a");
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
	layout.getState().setActive("a");
	layout.getState().setFocused("a");
	expect(layout.getState().dirty).toBe(false);
	expect(layout.getState().activeTabId).toBe("a");
	expect(layout.getState().focusedTerminalId).toBe("a");
});

test("moving and resizing go through the tree and mark the layout dirty", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().addTab("b");
	layout.getState().moveTab(1, 0);
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
	layout.getState().splitLeaf("a", "row", "c");
	layout.getState().clearDirty();
	layout.getState().resize("a", [], [70, 30]);
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

test("a terminal reconcile already placed is not left in two places", () => {
	// A create refetches the list, so reconcile may put the new terminal in a
	// tab of its own before the action that asked for it places it.
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().reconcile(["a", "b"]);
	layout.getState().replaceLeaf("a", "b");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["b"]);
	expect(layout.getState().layout.tabs).toHaveLength(1);
});

test("splitting in a terminal reconcile already placed keeps one tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().reconcile(["a", "b"]);
	layout.getState().splitLeaf("a", "row", "b");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a", "b"]);
	expect(layout.getState().layout.tabs).toHaveLength(1);
});

test("opening a tab for a terminal reconcile already placed makes one tab", () => {
	const layout = store();
	layout.getState().reconcile(["a"]);
	layout.getState().addTab("a");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a"]);
	expect(layout.getState().layout.tabs).toHaveLength(1);
});

test("replacing a pane keeps one tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().replaceLeaf("a", "b");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["b"]);
});

test("opening a file activates its tab, and opening it again just activates it", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	expect(layout.getState().layout.tabs).toHaveLength(2);

	layout.getState().setActive("a");
	layout.getState().clearDirty();
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	expect(layout.getState().layout.tabs).toHaveLength(2);
	// Nothing changed, so there is nothing to save.
	expect(layout.getState().dirty).toBe(false);
});

test("a diff tab is separate from the file tab for the same path", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().openDiff("src/app.ts");
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
		"diff:src/app.ts",
	]);
	expect(layout.getState().activeTabId).toBe("diff:src/app.ts");
});

test("closing a file tab removes it and marks the layout dirty", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().clearDirty();
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().layout.tabs).toEqual([]);
	expect(layout.getState().activeTabId).toBeNull();
	expect(layout.getState().dirty).toBe(true);
});

test("the line a file was opened at is handed out once", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", 42);
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBe(42);
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBeUndefined();
	// A file opened with no line asks the editor for nothing.
	layout.getState().openFile("src/other.ts");
	expect(layout.getState().consumePendingLine("file:src/other.ts")).toBeUndefined();
});

test("reopening a file with no line forgets the line it was opened at before", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", 42);
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBeUndefined();
});

test("closing a file tab forgets the line it was waiting to jump to", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", 42);
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().pendingLine).toEqual({});
});

test("opening a file is refused when the tab strip is full", () => {
	const layout = store();
	for (let i = 0; i < MAX_LAYOUT_TABS; i++) layout.getState().addTab(`t${i}`);
	const before = layout.getState().layout;
	expect(layout.getState().openFile("src/app.ts", 7)).toBe(false);
	expect(layout.getState().openDiff("src/app.ts")).toBe(false);
	// The layout and the active tab are left exactly as they were.
	expect(layout.getState().layout).toBe(before);
	expect(layout.getState().activeTabId).toBe(`t${MAX_LAYOUT_TABS - 1}`);
	expect(layout.getState().pendingLine).toEqual({});
});
