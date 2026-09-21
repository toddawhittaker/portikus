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

test("asking for the diff of an open file reuses that tab (issue #160)", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().addTab("a");
	layout.getState().openFile("src/app.ts", { diff: true });
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
		"a",
	]);
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	// The tab is told once to show its diff.
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(true);
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(false);
});

test("a file opened for editing is not asked to show its diff", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(false);
});

test("a saved diff tab loads as the file's tab showing its diff", () => {
	const layout = store();
	layout.getState().load({
		tabs: [{ id: "diff:src/app.ts", root: { type: "diff", path: "src/app.ts" } }],
	});
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
	]);
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(true);
	// The old shape is gone, so the layout is worth saving again.
	expect(layout.getState().dirty).toBe(true);
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
	layout.getState().openFile("src/app.ts", { line: 42 });
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBe(42);
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBeUndefined();
	// A file opened with no line asks the editor for nothing.
	layout.getState().openFile("src/other.ts");
	expect(layout.getState().consumePendingLine("file:src/other.ts")).toBeUndefined();
});

test("reopening a file with no line forgets the line it was opened at before", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 42 });
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingLine("file:src/app.ts")).toBeUndefined();
});

test("closing a file tab forgets the line it was waiting to jump to", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 42, diff: true });
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().pendingLine).toEqual({});
	expect(layout.getState().pendingDiff).toEqual({});
});

test("a full strip still opens another file; there is no cap (issue #240)", () => {
	const layout = store();
	for (let i = 0; i < 16; i++) layout.getState().addTab(`t${i}`);
	layout.getState().openFile("src/app.ts", { line: 7 });
	expect(layout.getState().layout.tabs).toHaveLength(17);
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	expect(layout.getState().pendingLine).toEqual({ "file:src/app.ts": 7 });
});

test("a file tab reports unsaved edits and forgets them again (issue #240)", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().unsavedTabs).toEqual({});
	layout.getState().setTabUnsaved("file:src/app.ts", true);
	expect(layout.getState().unsavedTabs).toEqual({ "file:src/app.ts": true });
	layout.getState().setTabUnsaved("file:src/app.ts", false);
	expect(layout.getState().unsavedTabs).toEqual({});
});

test("opening a file for editing asks its tab for the editor", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { diff: true });
	// Opening the file again from the tree or a terminal link must take the
	// tab out of diff view, so the diff request is replaced by an edit one.
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(false);
	expect(layout.getState().consumePendingEdit("file:src/app.ts")).toBe(true);
	expect(layout.getState().consumePendingEdit("file:src/app.ts")).toBe(false);
});

test("asking for the diff cancels an edit request that was waiting", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().openFile("src/app.ts", { diff: true });
	expect(layout.getState().consumePendingEdit("file:src/app.ts")).toBe(false);
	expect(layout.getState().consumePendingDiff("file:src/app.ts")).toBe(true);
});

test("closing a file tab forgets the editor request it was waiting for", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().pendingEdit).toEqual({});
});

test("a file's zoom is kept for the session and dropped with the tab", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().setZoom("src/app.ts", 130);
	expect(layout.getState().zooms).toEqual({ "src/app.ts": 130 });
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().zooms).toEqual({});
});

test("a file tab's view state is kept and dropped with the tab", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().setViewState("src/app.ts", { line: 42 });
	expect(layout.getState().viewStates).toEqual({ "src/app.ts": { line: 42 } });
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().viewStates).toEqual({});
});

test("closing a terminal tab leaves the file view states alone", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().setViewState("src/app.ts", { line: 42 });
	layout.getState().addTab("a");
	layout.getState().closeTab("a");
	expect(layout.getState().viewStates).toEqual({ "src/app.ts": { line: 42 } });
});

test("what this browser remembered is put back, and the saved layout keeps it", () => {
	const layout = store();
	layout.getState().restoreLocal({
		activeTabId: "file:src/app.ts",
		viewStates: { "src/app.ts": { line: 42 } },
	});
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	// The saved layout arrives afterwards and must not move the student.
	layout.getState().load({
		tabs: [
			{ id: "a", root: { type: "leaf", terminalId: "a" } },
			{ id: "file:src/app.ts", root: { type: "file", path: "src/app.ts" } },
		],
	});
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	expect(layout.getState().viewStates).toEqual({ "src/app.ts": { line: 42 } });
});

test("a remembered tab that is no longer in the layout falls back to the first", () => {
	const layout = store();
	layout.getState().restoreLocal({ activeTabId: "file:src/gone.ts", viewStates: {} });
	layout
		.getState()
		.load({ tabs: [{ id: "a", root: { type: "leaf", terminalId: "a" } }] });
	expect(layout.getState().activeTabId).toBe("a");
});

test("closing the active tab goes back to the last tab that was active", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().openFile("b.ts");
	layout.getState().openFile("c.ts");
	layout.getState().setActive("file:a.ts");
	layout.getState().setActive("file:c.ts");
	layout.getState().closeTab("file:c.ts");
	expect(layout.getState().activeTabId).toBe("file:a.ts");
});

test("with no history the tab to the left takes over", () => {
	const layout = store();
	layout.getState().load({
		tabs: [
			{ id: "a", root: { type: "file", path: "a.ts" } },
			{ id: "b", root: { type: "file", path: "b.ts" } },
			{ id: "c", root: { type: "file", path: "c.ts" } },
		],
	});
	layout.getState().setActive("b");
	// Only "b" was ever active, so its own history entry goes with it.
	layout.getState().closeTab("b");
	expect(layout.getState().activeTabId).toBe("a");
});

test("closing the leftmost tab with no history takes the tab to its right", () => {
	const layout = store();
	layout.getState().load({
		tabs: [
			{ id: "a", root: { type: "file", path: "a.ts" } },
			{ id: "b", root: { type: "file", path: "b.ts" } },
		],
	});
	layout.getState().setActive("a");
	layout.getState().closeTab("a");
	expect(layout.getState().activeTabId).toBe("b");
});

test("closing the last tab leaves no active tab", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().closeTab("file:a.ts");
	expect(layout.getState().activeTabId).toBeNull();
});

test("closing a tab that is not active leaves the active tab alone", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().openFile("b.ts");
	layout.getState().openFile("c.ts");
	layout.getState().setActive("file:b.ts");
	layout.getState().closeTab("file:a.ts");
	expect(layout.getState().activeTabId).toBe("file:b.ts");
});

test("a closed tab is forgotten, so reopening it does not jump backwards", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().openFile("b.ts");
	layout.getState().openFile("c.ts");
	layout.getState().closeTab("file:c.ts");
	expect(layout.getState().activeTabId).toBe("file:b.ts");
	layout.getState().closeTab("file:b.ts");
	expect(layout.getState().activeTabId).toBe("file:a.ts");
});
