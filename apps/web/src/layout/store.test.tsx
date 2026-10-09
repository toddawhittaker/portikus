import { expect, test } from "vitest";
import { createLayoutStore } from "./store";
import { filePaths, layoutTerminalIds, terminalIds } from "./tree";

/** SPEC.md §11.2: a rename or move from the files pane keeps the file's tab. */
test("a renamed file keeps its tab, active, with what this browser kept for it", () => {
	const layout = store();
	layout.getState().addTab("t1");
	layout.getState().openFile("a.txt", { diff: true, baseline: "abc123" });
	layout.getState().setTabUnsaved("file:a.txt", true);
	layout.getState().setViewState("a.txt", { cursor: 4 });
	layout.getState().setZoom("a.txt", 120);
	layout.getState().clearDirty();

	layout.getState().retargetTabs("a.txt", "b.txt");
	const state = layout.getState();
	expect(state.layout.tabs.map((tab) => tab.id)).toEqual(["t1", "file:b.txt"]);
	expect(state.activeTabId).toBe("file:b.txt");
	expect(state.tabHistory).not.toContain("file:a.txt");
	expect(state.diffBaseline).toEqual({ "file:b.txt": "abc123" });
	expect(state.pendingView["file:b.txt"]?.mode).toBe("diff");
	expect(state.pendingView["file:a.txt"]).toBeUndefined();
	expect(state.unsavedTabs).toEqual({ "file:b.txt": true });
	expect(state.viewStates).toEqual({ "b.txt": { cursor: 4 } });
	expect(state.zooms).toEqual({ "b.txt": 120 });
	expect(state.dirty).toBe(true);
});

test("a moved folder retargets the files inside it, a file in a split included", () => {
	const layout = store();
	layout.getState().addTab("t1");
	layout.getState().openFile("src/a.ts");
	layout.getState().openFile("src/deep/b.ts", { diff: true, baseline: "def456" });
	layout.getState().openFile("srcx/c.ts");
	layout.getState().moveLeaf("t1", "file:src/a.ts", "t1", "right");
	layout.getState().setActive("t1");

	layout.getState().retargetTabs("src", "lib");
	const state = layout.getState();
	expect(state.layout.tabs.flatMap((tab) => filePaths(tab.root))).toEqual([
		"lib/a.ts",
		"lib/deep/b.ts",
		"srcx/c.ts",
	]);
	// The split tab keeps its id and stays active.
	expect(state.activeTabId).toBe("t1");
	expect(state.diffBaseline["file:lib/deep/b.ts"]).toBe("def456");
	expect(state.diffBaseline["file:srcx/c.ts"]).toBeNull();
	expect(Object.keys(state.diffBaseline).some((key) => key.includes("src/"))).toBe(
		false,
	);
});

test("a move hands an open editor's unsaved text to the file's new path", () => {
	const layout = store();
	layout.getState().openFile("src/a.ts");
	const release = layout.getState().registerBuffer("src/a.ts", () => "unsaved text");
	layout.getState().retargetTabs("src", "lib");
	// The editor unmounting at the old path finds its text already taken.
	expect(release()).toBe(false);
	expect(layout.getState().takeBuffer("lib/a.ts")).toBe("unsaved text");
	expect(layout.getState().takeBuffer("lib/a.ts")).toBeUndefined();
});

/** SPEC.md §11.2: Replace overwrites the open file with the one that moved. */
test("a move onto an open file replaces its editor with the moved file's text", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().openFile("b.ts");
	const releaseA = layout.getState().registerBuffer("a.ts", () => "a unsaved");
	const releaseB = layout.getState().registerBuffer("b.ts", () => "b unsaved");
	const before = layout.getState().fileGenerations["b.ts"] ?? 0;

	layout.getState().retargetTabs("a.ts", "b.ts");
	// The pane at b.ts mounts again, so it can take the text that arrived.
	expect(layout.getState().fileGenerations["b.ts"]).toBe(before + 1);
	expect(releaseA()).toBe(false);
	// The replaced editor's text goes with its file, not to the next mount.
	expect(releaseB()).toBe(false);
	expect(layout.getState().takeBuffer("b.ts")).toBe("a unsaved");
});

test("a replaced file's leftover text does not survive a move with nothing unsaved", () => {
	const layout = store();
	layout.getState().openFile("a.ts");
	layout.getState().openFile("b.ts");
	layout.getState().carryBuffer("b.ts", "stale");
	layout.getState().registerBuffer("a.ts", () => null);

	layout.getState().retargetTabs("a.ts", "b.ts");
	expect(layout.getState().takeBuffer("b.ts")).toBeUndefined();
});

test("text kept across a remount is dropped once its file is closed", () => {
	const layout = store();
	layout.getState().openFile("a.txt");
	const release = layout.getState().registerBuffer("a.txt", () => null);
	expect(release()).toBe(true);
	layout.getState().carryBuffer("a.txt", "kept");
	layout.getState().closeFile("a.txt");
	expect(layout.getState().takeBuffer("a.txt")).toBeUndefined();
	// A file that is not open keeps nothing at all.
	layout.getState().carryBuffer("a.txt", "kept");
	expect(layout.getState().takeBuffer("a.txt")).toBeUndefined();
});

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

test("asking for the diff of an open file reuses that tab", () => {
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
	expect(layout.getState().consumePendingView("file:src/app.ts")?.mode).toBe("diff");
	expect(layout.getState().consumePendingView("file:src/app.ts")).toBeUndefined();
});

test("a file opened for editing is not asked to show its diff", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingView("file:src/app.ts")?.mode).toBe("edit");
});

test("a saved diff tab loads as the file's tab showing its diff", () => {
	const layout = store();
	layout.getState().load({
		tabs: [{ id: "diff:src/app.ts", root: { type: "diff", path: "src/app.ts" } }],
	});
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
	]);
	expect(layout.getState().consumePendingView("file:src/app.ts")?.mode).toBe("diff");
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
	expect(layout.getState().consumePendingView("file:src/app.ts")?.line).toBe(42);
	expect(layout.getState().consumePendingView("file:src/app.ts")).toBeUndefined();
	// A file opened with no line asks the editor for no line.
	layout.getState().openFile("src/other.ts");
	expect(
		layout.getState().consumePendingView("file:src/other.ts")?.line,
	).toBeUndefined();
});

test("reopening a file with no line forgets the line it was opened at before", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 42 });
	layout.getState().openFile("src/app.ts");
	expect(layout.getState().consumePendingView("file:src/app.ts")?.line).toBeUndefined();
});

test("closing a file tab forgets the line it was waiting to jump to", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 42, diff: true });
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().pendingView).toEqual({});
});

test("a full strip still opens another file; there is no cap", () => {
	const layout = store();
	for (let i = 0; i < 16; i++) layout.getState().addTab(`t${i}`);
	layout.getState().openFile("src/app.ts", { line: 7 });
	expect(layout.getState().layout.tabs).toHaveLength(17);
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
	expect(layout.getState().pendingView["file:src/app.ts"]?.line).toBe(7);
});

test("a file tab reports unsaved edits and forgets them again", () => {
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
	expect(layout.getState().consumePendingView("file:src/app.ts")?.mode).toBe("edit");
	expect(layout.getState().consumePendingView("file:src/app.ts")).toBeUndefined();
});

test("asking for the diff cancels an edit request that was waiting", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().openFile("src/app.ts", { diff: true });
	expect(layout.getState().consumePendingView("file:src/app.ts")?.mode).toBe("diff");
	expect(layout.getState().consumePendingView("file:src/app.ts")).toBeUndefined();
});

test("closing a file tab forgets the editor request it was waiting for", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts");
	layout.getState().closeTab("file:src/app.ts");
	expect(layout.getState().pendingView).toEqual({});
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

test("each request for a tab is new, even when it repeats the last one", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 3 });
	const first = layout.getState().pendingView["file:src/app.ts"]?.seq;
	layout.getState().openFile("src/app.ts", { line: 3 });
	expect(layout.getState().pendingView["file:src/app.ts"]?.seq).not.toBe(first);
});

test("a diff request carries its line with it", () => {
	const layout = store();
	layout.getState().openFile("src/app.ts", { line: 9, diff: true });
	expect(layout.getState().consumePendingView("file:src/app.ts")).toMatchObject({
		mode: "diff",
		line: 9,
	});
});

/** Terminal "a" in tab "a", with src/app.ts moved into a split beside it. */
function fileBesideTerminal() {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().openFile("src/app.ts", { line: 3 });
	layout.getState().moveLeaf("a", "file:src/app.ts", "a", "right");
	return layout;
}

test("a file moved beside a terminal shows the tab it landed in", () => {
	const layout = fileBesideTerminal();
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual(["a"]);
	expect(layout.getState().activeTabId).toBe("a");
	// Opening it again finds it in the split and asks that pane, not a new tab.
	layout.getState().openFile("src/app.ts", { diff: true });
	expect(layout.getState().layout.tabs).toHaveLength(1);
	expect(layout.getState().activeTabId).toBe("a");
	expect(layout.getState().pendingView["file:src/app.ts"]?.mode).toBe("diff");
});

test("closing a file in a split leaves the terminal and forgets the file", () => {
	const layout = fileBesideTerminal();
	layout.getState().setViewState("src/app.ts", { top: 9 });
	layout.getState().setZoom("src/app.ts", 120);
	layout.getState().closeFile("src/app.ts");
	expect(layoutTerminalIds(layout.getState().layout)).toEqual(["a"]);
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual(["a"]);
	expect(layout.getState().activeTabId).toBe("a");
	expect(layout.getState().viewStates).toEqual({});
	expect(layout.getState().zooms).toEqual({});
	expect(layout.getState().pendingView).toEqual({});
});

test("closing a file alone in its tab closes the tab", () => {
	const layout = store();
	layout.getState().addTab("a");
	layout.getState().openFile("src/app.ts");
	layout.getState().closeFile("src/app.ts");
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual(["a"]);
	expect(layout.getState().activeTabId).toBe("a");
});

test("when the terminal beside a file ends, the active tab follows the file", () => {
	const layout = fileBesideTerminal();
	layout.getState().reconcile([]);
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
	]);
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
});

test("closing a tab forgets every file in its splits", () => {
	const layout = fileBesideTerminal();
	layout.getState().setViewState("src/app.ts", { top: 9 });
	layout.getState().closeTab("a");
	expect(layout.getState().viewStates).toEqual({});
	expect(layout.getState().pendingView).toEqual({});
});

test("a file dragged out of a split to the strip gets its own tab back", () => {
	const layout = fileBesideTerminal();
	layout.getState().moveLeafToNewTab("file:src/app.ts", 1);
	expect(layout.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"a",
		"file:src/app.ts",
	]);
	expect(layout.getState().activeTabId).toBe("file:src/app.ts");
});
