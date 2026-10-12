import {
	MAX_SPLIT_DEPTH,
	type ProjectLayout,
	type SplitNode,
} from "@portikus/contracts";
import { expect, test } from "vitest";
import { createLayoutStore } from "../layout/store.js";
import { moveLeaf } from "../layout/tree.js";
import {
	dropTreeFile,
	dropTreeFiles,
	fileDropTarget,
	moveIntoTargets,
	openedFilesText,
	openTreeFiles,
	paneName,
} from "./moveInto.js";

const leaf = (terminalId: string): SplitNode => ({ type: "leaf", terminalId });

const layout: ProjectLayout = {
	tabs: [
		{ id: "a", root: leaf("t1") },
		{ id: "file:readme.md", root: { type: "file", path: "readme.md" } },
		{
			id: "b",
			root: {
				type: "split",
				direction: "row",
				sizes: [50, 50],
				children: [leaf("t2"), leaf("t3")],
			},
		},
		{ id: "preview:3000", root: { type: "preview", port: 3000 } },
		{ id: "c", root: leaf("t4") },
	],
};

test("offers every other tab with panes, in tab order, beside its last pane", () => {
	// A file's tab takes a terminal beside it; a preview is always a whole tab.
	expect(moveIntoTargets(layout, "t1")).toEqual([
		{ tabId: "file:readme.md", paneId: "file:readme.md", edge: "right" },
		{ tabId: "b", paneId: "t3", edge: "right" },
		{ tabId: "c", paneId: "t4", edge: "right" },
	]);
});

test("never offers the pane's own tab", () => {
	expect(moveIntoTargets(layout, "t2").map((target) => target.tabId)).toEqual([
		"a",
		"file:readme.md",
		"c",
	]);
	expect(
		moveIntoTargets(layout, "file:readme.md").map((target) => target.tabId),
	).toEqual(["a", "b", "c"]);
});

test("a file moved into a terminal tab joins its split", () => {
	const next = moveLeaf(layout, "a", "file:readme.md", "t1", "right");
	expect(next.tabs.find((tab) => tab.id === "a")?.root).toEqual({
		type: "split",
		direction: "row",
		sizes: [50, 50],
		children: [leaf("t1"), { type: "file", path: "readme.md" }],
	});
	expect(next.tabs.map((tab) => tab.id)).not.toContain("file:readme.md");
});

test("moving into a target joins that tab's split, as the drag does", () => {
	const [target] = moveIntoTargets(layout, "t4").filter((t) => t.tabId === "b");
	if (!target) throw new Error("tab b was not offered");
	const next = moveLeaf(layout, target.tabId, "t4", target.paneId, target.edge);
	expect(next.tabs.find((tab) => tab.id === "b")?.root).toEqual({
		type: "split",
		direction: "row",
		sizes: [33.33, 33.33, 33.34],
		children: [leaf("t2"), leaf("t3"), leaf("t4")],
	});
	// The tab the pane left was emptied, so it is gone.
	expect(next.tabs.map((tab) => tab.id)).not.toContain("c");
});

/** A tab nested to the limit, whose last pane sits in a top-to-bottom split. */
function deepest(depth: number): SplitNode {
	let node: SplitNode = leaf("deep");
	for (let level = 0; level < depth; level++) {
		node = {
			type: "split",
			direction: level % 2 === 0 ? "column" : "row",
			sizes: [50, 50],
			children: [leaf(`side-${level}`), node],
		};
	}
	return node;
}

test("a tab already at the depth limit is not offered", () => {
	const full: ProjectLayout = {
		tabs: [
			{ id: "a", root: leaf("t1") },
			{ id: "deep", root: deepest(MAX_SPLIT_DEPTH) },
		],
	};
	expect(moveIntoTargets(full, "t1")).toEqual([]);
});

test("a tree file dropped on a pane's edge lands beside that pane", () => {
	expect(fileDropTarget(layout, "src/new.ts", "t3", "bottom")).toEqual({
		tabId: "b",
		paneId: "t3",
		edge: "bottom",
	});
	expect(fileDropTarget(layout, "src/new.ts", "file:readme.md", "right")).toEqual({
		tabId: "file:readme.md",
		paneId: "file:readme.md",
		edge: "right",
	});
});

test("an already open file dropped on another pane's edge is a move", () => {
	expect(fileDropTarget(layout, "readme.md", "t1", "left")).toEqual({
		tabId: "a",
		paneId: "t1",
		edge: "left",
	});
});

test("a tree file takes no drop on its own pane, the centre, or an unknown pane", () => {
	expect(fileDropTarget(layout, "readme.md", "file:readme.md", "right")).toBeNull();
	expect(fileDropTarget(layout, "src/new.ts", "t1", "center")).toBeNull();
	expect(fileDropTarget(layout, "src/new.ts", "gone", "right")).toBeNull();
});

test("a tree file takes no drop that would split past the depth limit", () => {
	const full: ProjectLayout = {
		tabs: [{ id: "deep", root: deepest(MAX_SPLIT_DEPTH) }],
	};
	expect(fileDropTarget(full, "src/new.ts", "deep", "right")).toBeNull();
});

test("dropping an open file from the tree keeps its Diff view and baseline", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	store.getState().openFile("readme.md", { diff: true, baseline: "HEAD~1" });
	const before = store.getState();
	const view = before.pendingView["file:readme.md"];
	dropTreeFile(before, "readme.md", { tabId: "a", paneId: "t1", edge: "right" });
	const after = store.getState();
	expect(after.pendingView["file:readme.md"]).toBe(view);
	expect(after.diffBaseline["file:readme.md"]).toBe("HEAD~1");
	expect(after.layout.tabs.map((tab) => tab.id)).toEqual(["a"]);
	expect(after.focusedPaneId).toBe("file:readme.md");
});

test("dropping a file not yet open from the tree opens it beside the target", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	dropTreeFile(store.getState(), "src/new.ts", {
		tabId: "a",
		paneId: "t1",
		edge: "right",
	});
	const root = store.getState().layout.tabs[0]?.root;
	expect(root?.type).toBe("split");
	expect(store.getState().pendingView["file:src/new.ts"]?.mode).toBe("edit");
});

test("several files from the tree open as one split plus tabs, and the split stays shown", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	dropTreeFiles(store.getState, ["one.ts", "two.ts", "three.ts"], {
		tabId: "a",
		paneId: "t1",
		edge: "right",
	});
	const state = store.getState();
	expect(state.layout.tabs.map((tab) => tab.id)).toEqual([
		"a",
		"file:two.ts",
		"file:three.ts",
	]);
	expect(state.layout.tabs[0]?.root).toMatchObject({
		type: "split",
		children: [leaf("t1"), { type: "file", path: "one.ts" }],
	});
	expect(state.activeTabId).toBe("a");
	expect(state.focusedPaneId).toBe("file:one.ts");
});

test("a pane with no other terminal tab has nowhere to go", () => {
	expect(moveIntoTargets({ tabs: [{ id: "a", root: leaf("t1") }] }, "t1")).toEqual([]);
});

test("opening a selection from the menu splits right of the focused pane", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	store.getState().setFocused("t1");
	openTreeFiles(store.getState, ["one.ts", "two.ts"]);
	const state = store.getState();
	expect(state.layout.tabs.map((tab) => tab.id)).toEqual(["a", "file:two.ts"]);
	expect(state.layout.tabs[0]?.root.type).toBe("split");
	expect(state.activeTabId).toBe("a");
	expect(state.focusedPaneId).toBe("file:one.ts");
});

test("opening a selection with no focused pane opens every file as a tab", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	openTreeFiles(store.getState, ["one.ts", "two.ts"]);
	expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"a",
		"file:one.ts",
		"file:two.ts",
	]);
});

test("opening a selection reports the pane the split went beside, or none", () => {
	const store = createLayoutStore();
	store.getState().load({ tabs: [{ id: "a", root: leaf("t1") }] });
	expect(openTreeFiles(store.getState, ["one.ts"])).toBeNull();
	store.getState().setFocused("t1");
	expect(openTreeFiles(store.getState, ["two.ts"])).toEqual({
		tabId: "a",
		paneId: "t1",
		edge: "right",
	});
	expect(openTreeFiles(store.getState, [])).toBeNull();
});

test("the announcement says where each opened file went", () => {
	expect(openedFilesText(["notes.md"], "Terminal 1")).toBe(
		"Opened notes.md beside Terminal 1.",
	);
	expect(openedFilesText(["notes.md", "other.md"], "Terminal 1")).toBe(
		"Opened notes.md beside Terminal 1 and other.md as a tab.",
	);
	expect(openedFilesText(["a.md", "b.md", "c.md"], "readme.md")).toBe(
		"Opened a.md beside readme.md and 2 more files as tabs.",
	);
	expect(openedFilesText(["notes.md"], null)).toBe("Opened notes.md as a tab.");
	expect(openedFilesText(["a.md", "b.md"], null)).toBe("Opened 2 files as tabs.");
	expect(openedFilesText([], null)).toBe("");
});

test("the announcement names the pane the split went beside as its tab does", () => {
	const nested: ProjectLayout = {
		tabs: [
			{
				id: "a",
				root: {
					type: "split",
					direction: "row",
					sizes: [50, 50],
					children: [leaf("t1"), { type: "file", path: "src/notes‮.md" }],
				},
			},
		],
	};
	const terminals = [{ id: "t1", name: "Build‎ shell" }];
	// A file pane, even inside a split, goes by its base name, drawn safely.
	expect(paneName(nested, terminals, "file:src/notes‮.md")).toBe("notes.md");
	expect(paneName(nested, terminals, "t1")).toBe("Build shell");
	// A terminal the list has not caught up with yet still gets a name.
	expect(paneName(nested, [], "t1")).toBe("the focused terminal");
});
