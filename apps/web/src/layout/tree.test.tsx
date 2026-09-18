import type { ProjectLayout, SplitNode } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	addTab,
	closeTab,
	emptyLayout,
	evenSizes,
	layoutTerminalIds,
	moveLeaf,
	moveLeafToNewTab,
	moveTab,
	normaliseSizes,
	openDiff,
	openFile,
	reconcile,
	removeLeaf,
	replaceLeaf,
	resize,
	splitLeaf,
	terminalIds,
} from "./tree";

function leaf(id: string): SplitNode {
	return { type: "leaf", terminalId: id };
}

function oneTab(root: SplitNode, id = "tab1"): ProjectLayout {
	return { tabs: [{ id, root }] };
}

/** Sizes must always add up to 100 so a reload restores the same picture. */
function sumsTo100(node: SplitNode): boolean {
	if (node.type !== "split") return true;
	const total = node.sizes.reduce((sum, size) => sum + size, 0);
	return Math.abs(total - 100) < 0.001 && node.children.every(sumsTo100);
}

test("a new tab holds one terminal and goes last", () => {
	const layout = addTab(addTab(emptyLayout(), "a", "t1"), "b", "t2");
	expect(layout.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
	expect(layoutTerminalIds(layout)).toEqual(["a", "b"]);
});

test("splitting a lone leaf right makes a row of two equal panes", () => {
	const layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.direction).toBe("row");
	expect(root.sizes).toEqual([50, 50]);
	expect(terminalIds(root)).toEqual(["a", "b"]);
});

test("splitting down makes a column", () => {
	const layout = splitLeaf(oneTab(leaf("a")), "a", "column", "b");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.direction).toBe("column");
});

test("splitting again in the same direction adds a sibling and rebalances", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "row", "c");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.children).toHaveLength(3);
	expect(terminalIds(root)).toEqual(["a", "b", "c"]);
	expect(evenSizes(3)).toEqual(root.sizes);
	expect(sumsTo100(root)).toBe(true);
});

test("splitting the other way nests a new split inside", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "column", "c");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.children).toHaveLength(2);
	const nested = root.children[1] as Extract<SplitNode, { type: "split" }>;
	expect(nested.direction).toBe("column");
	expect(terminalIds(nested)).toEqual(["b", "c"]);
	expect(sumsTo100(root)).toBe(true);
});

test("a split nested two deep still finds its leaf", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "column", "c");
	layout = splitLeaf(layout, "c", "column", "d");
	expect(layoutTerminalIds(layout)).toEqual(["a", "b", "c", "d"]);
});

test("removing one of two panes collapses the split back to a leaf", () => {
	const layout = removeLeaf(splitLeaf(oneTab(leaf("a")), "a", "row", "b"), "b");
	expect(layout.tabs[0]?.root).toEqual(leaf("a"));
});

test("removing one of three panes keeps the split and renormalises", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "row", "c");
	layout = removeLeaf(layout, "b");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(terminalIds(root)).toEqual(["a", "c"]);
	expect(sumsTo100(root)).toBe(true);
});

test("removing the last pane drops the tab", () => {
	expect(removeLeaf(oneTab(leaf("a")), "a").tabs).toEqual([]);
});

test("removing an unknown terminal changes nothing", () => {
	const layout = oneTab(leaf("a"));
	expect(removeLeaf(layout, "zz")).toEqual(layout);
});

test("replacing a leaf keeps its place in the tree", () => {
	const layout = replaceLeaf(splitLeaf(oneTab(leaf("a")), "a", "row", "b"), "a", "c");
	expect(layoutTerminalIds(layout)).toEqual(["c", "b"]);
});

test("moving a tab reorders it, and out-of-range moves are ignored", () => {
	const layout = addTab(addTab(addTab(emptyLayout(), "a", "1"), "b", "2"), "c", "3");
	expect(moveTab(layout, 0, 2).tabs.map((tab) => tab.id)).toEqual(["2", "3", "1"]);
	expect(moveTab(layout, 2, 0).tabs.map((tab) => tab.id)).toEqual(["3", "1", "2"]);
	expect(moveTab(layout, 1, 1)).toEqual(layout);
	expect(moveTab(layout, -1, 1)).toEqual(layout);
	expect(moveTab(layout, 0, 9)).toEqual(layout);
});

test("resize writes normalised sizes at the addressed split", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "column", "c");
	layout = resize(layout, "tab1", [], [70, 30]);
	layout = resize(layout, "tab1", [1], [20, 80]);
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.sizes).toEqual([70, 30]);
	expect((root.children[1] as Extract<SplitNode, { type: "split" }>).sizes).toEqual([
		20, 80,
	]);
	expect(sumsTo100(root)).toBe(true);
});

test("resize ignores a wrong tab, a wrong path, or the wrong number of sizes", () => {
	const layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	expect(resize(layout, "other", [], [70, 30])).toEqual(layout);
	expect(resize(layout, "tab1", [5], [70, 30])).toEqual(layout);
	expect(resize(layout, "tab1", [], [70, 20, 10])).toEqual(layout);
});

test("sizes that do not add up are scaled to 100", () => {
	expect(normaliseSizes([1, 1])).toEqual([50, 50]);
	expect(normaliseSizes([0, 0])).toEqual([50, 50]);
	expect(normaliseSizes([30, 30, 30]).reduce((sum, size) => sum + size, 0)).toBe(100);
});

test("reconcile gives every unplaced terminal a tab", () => {
	const layout = reconcile(emptyLayout(), ["a", "b"]);
	expect(layout.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
	expect(layoutTerminalIds(layout)).toEqual(["a", "b"]);
});

test("reconcile prunes a pane whose terminal is gone but keeps the rest", () => {
	const layout = reconcile(splitLeaf(oneTab(leaf("a")), "a", "row", "b"), ["a"]);
	expect(layout.tabs[0]?.root).toEqual(leaf("a"));
});

test("reconcile keeps an ended terminal, because it is still in the list", () => {
	const layout = reconcile(oneTab(leaf("a")), ["a"]);
	expect(layoutTerminalIds(layout)).toEqual(["a"]);
});

test("reconcile does not bring back an ended terminal that lost its leaf", () => {
	// A revive swaps the ended id out of the layout; the row stays in the
	// listing as history (SPEC.md §9.7) and must not come back as a tab.
	const layout = reconcile(oneTab(leaf("b")), ["a", "b"], ["a"]);
	expect(layoutTerminalIds(layout)).toEqual(["b"]);
});

test("reconcile still gives a live terminal from another window a tab", () => {
	const layout = reconcile(oneTab(leaf("a")), ["a", "b"], ["c"]);
	expect(layoutTerminalIds(layout)).toEqual(["a", "b"]);
});

test("reconcile keeps the leaf of an ended terminal it already shows", () => {
	const layout = reconcile(oneTab(leaf("a")), ["a"], ["a"]);
	expect(layoutTerminalIds(layout)).toEqual(["a"]);
});

test("reconcile with nothing to do returns the same layout", () => {
	const layout = oneTab(leaf("a"));
	expect(reconcile(layout, ["a"])).toBe(layout);
});

/** A split node, for the assertions that read its direction and sizes. */
function split(node: SplitNode | undefined): Extract<SplitNode, { type: "split" }> {
	if (node?.type !== "split") throw new Error("expected a split");
	return node;
}

test("dragging the lower pane to the right edge turns a column into a row", () => {
	const column = splitLeaf(oneTab(leaf("a")), "a", "column", "b");
	const layout = moveLeaf(column, "tab1", "b", "a", "right");
	const root = split(layout.tabs[0]?.root);
	expect(root.direction).toBe("row");
	expect(terminalIds(root)).toEqual(["a", "b"]);
	expect(root.sizes).toEqual([50, 50]);
	expect(sumsTo100(root)).toBe(true);
});

test("and dragging it back to the bottom edge turns the row into a column", () => {
	const row = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	const layout = moveLeaf(row, "tab1", "b", "a", "bottom");
	const root = split(layout.tabs[0]?.root);
	expect(root.direction).toBe("column");
	expect(terminalIds(root)).toEqual(["a", "b"]);
});

test("the left edge inserts the pane before its target", () => {
	const row = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	const layout = moveLeaf(row, "tab1", "b", "a", "left");
	expect(terminalIds(split(layout.tabs[0]?.root))).toEqual(["b", "a"]);
});

test("the top edge inserts the pane above its target", () => {
	const column = splitLeaf(oneTab(leaf("a")), "a", "column", "b");
	const layout = moveLeaf(column, "tab1", "b", "a", "top");
	expect(terminalIds(split(layout.tabs[0]?.root))).toEqual(["b", "a"]);
});

test("a pane joins an existing split of the same direction as a sibling", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "row", "c");
	layout = moveLeaf(layout, "tab1", "c", "a", "left");
	const root = split(layout.tabs[0]?.root);
	expect(terminalIds(root)).toEqual(["c", "a", "b"]);
	expect(root.sizes).toEqual(evenSizes(3));
	expect(sumsTo100(root)).toBe(true);
});

test("dropping on the centre swaps the two panes", () => {
	let layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	layout = splitLeaf(layout, "b", "column", "c");
	const swapped = moveLeaf(layout, "tab1", "a", "c", "center");
	expect(terminalIds(swapped.tabs[0]?.root as SplitNode)).toEqual(["c", "b", "a"]);
	// The shape is untouched: only the two terminal ids traded places.
	expect(split(swapped.tabs[0]?.root).direction).toBe("row");
});

test("a pane dragged out of another tab leaves that tab behind when it was alone", () => {
	const layout: ProjectLayout = {
		tabs: [
			{ id: "tab1", root: leaf("a") },
			{ id: "tab2", root: leaf("b") },
		],
	};
	const moved = moveLeaf(layout, "tab1", "b", "a", "right");
	expect(moved.tabs.map((tab) => tab.id)).toEqual(["tab1"]);
	expect(terminalIds(split(moved.tabs[0]?.root))).toEqual(["a", "b"]);
});

test("a pane dragged out of a split tab collapses the split it left", () => {
	const layout: ProjectLayout = {
		tabs: [
			{ id: "tab1", root: leaf("a") },
			{
				id: "tab2",
				root: splitLeaf(oneTab(leaf("b"), "tab2"), "b", "row", "c").tabs[0]
					?.root as SplitNode,
			},
		],
	};
	const moved = moveLeaf(layout, "tab1", "c", "a", "bottom");
	expect(moved.tabs.map((tab) => tab.id)).toEqual(["tab1", "tab2"]);
	expect(moved.tabs[1]?.root).toEqual(leaf("b"));
	expect(terminalIds(split(moved.tabs[0]?.root))).toEqual(["a", "c"]);
});

/** A tab nested to exactly `MAX_SPLIT_DEPTH`, with "deep" at the bottom. */
function deepTab(levels: number): SplitNode {
	if (levels <= 1) return leaf("deep");
	return {
		type: "split",
		direction: "column",
		sizes: evenSizes(2),
		children: [leaf(`p${levels}`), deepTab(levels - 1)],
	};
}

test("a move that would go past the depth limit is refused", () => {
	const layout: ProjectLayout = {
		tabs: [
			{ id: "tab1", root: deepTab(8) },
			{ id: "tab2", root: leaf("x") },
		],
	};
	// Splitting the deepest leaf would make a ninth level.
	expect(moveLeaf(layout, "tab1", "x", "deep", "right")).toBe(layout);
	// One level up there is still room.
	expect(moveLeaf(layout, "tab1", "x", "p3", "right")).not.toBe(layout);
});

test("moveLeaf ignores a pane dropped on itself or an unknown target", () => {
	const layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	expect(moveLeaf(layout, "tab1", "a", "a", "right")).toBe(layout);
	expect(moveLeaf(layout, "tab1", "a", "zz", "right")).toBe(layout);
	expect(moveLeaf(layout, "tab1", "zz", "a", "right")).toBe(layout);
	expect(moveLeaf(layout, "nope", "a", "b", "right")).toBe(layout);
});

test("a pane dragged to the tab strip becomes its own tab at that position", () => {
	let layout = addTab(emptyLayout(), "a", "tab1");
	layout = splitLeaf(layout, "a", "row", "b");
	layout = addTab(layout, "c", "tab2");
	const moved = moveLeafToNewTab(layout, "b", 1, "new1");
	expect(moved.tabs.map((tab) => tab.id)).toEqual(["tab1", "new1", "tab2"]);
	expect(moved.tabs[0]?.root).toEqual(leaf("a"));
	expect(moved.tabs[1]?.root).toEqual(leaf("b"));
});

test("moving the only pane of a tab to the strip just moves that tab", () => {
	const layout: ProjectLayout = {
		tabs: [
			{ id: "a", root: leaf("a") },
			{ id: "b", root: leaf("b") },
		],
	};
	const moved = moveLeafToNewTab(layout, "b", 0, "new1");
	expect(moved.tabs.map((tab) => tab.id)).toEqual(["new1", "a"]);
});

test("an out-of-range index lands at the nearest end of the strip", () => {
	let layout = addTab(emptyLayout(), "a", "tab1");
	layout = splitLeaf(layout, "a", "row", "b");
	expect(moveLeafToNewTab(layout, "b", 99, "new1").tabs.map((tab) => tab.id)).toEqual([
		"tab1",
		"new1",
	]);
	expect(moveLeafToNewTab(layout, "b", -3, "new1").tabs.map((tab) => tab.id)).toEqual([
		"new1",
		"tab1",
	]);
});

test("moveLeafToNewTab ignores a terminal that has no pane", () => {
	const layout = oneTab(leaf("a"));
	expect(moveLeafToNewTab(layout, "zz", 0, "new1")).toBe(layout);
});

test("a new tab past the tab limit is refused", () => {
	const tabs = Array.from({ length: 16 }, (_, index) => ({
		id: `tab${index}`,
		root: leaf(`t${index}`),
	}));
	// The first tab has two panes, so pulling one out would make a 17th tab.
	const full: ProjectLayout = {
		tabs: [
			{
				id: "tab0",
				root: splitLeaf(oneTab(leaf("t0"), "tab0"), "t0", "row", "extra").tabs[0]
					?.root as SplitNode,
			},
			...tabs.slice(1),
		],
	};
	expect(moveLeafToNewTab(full, "extra", 0, "fresh")).toBe(full);
});

test("a pane dragged out of a tab named after it gets a fresh tab id", () => {
	// Reconcile names each tab after its terminal, so tab "a" holds leaf "a".
	let layout = addTab(emptyLayout(), "a", "a");
	layout = addTab(layout, "b", "b");
	// Dragging b onto a's right edge leaves one tab, "a", holding both panes.
	layout = moveLeaf(layout, "a", "b", "a", "right");
	expect(layout.tabs.map((tab) => tab.id)).toEqual(["a"]);

	// Pulling a back out must not make a second tab that is also called "a".
	const moved = moveLeafToNewTab(layout, "a", 1, "fresh");
	expect(moved.tabs.map((tab) => tab.id)).toEqual(["a", "fresh"]);
	expect(new Set(moved.tabs.map((tab) => tab.id)).size).toBe(moved.tabs.length);
	expect(moved.tabs[0]?.root).toEqual(leaf("b"));
	expect(moved.tabs[1]?.root).toEqual(leaf("a"));
});

test("opening a file makes one tab and opening it again reuses that tab", () => {
	const first = openFile(emptyLayout(), "src/app.ts");
	expect(first.tabId).toBe("file:src/app.ts");
	expect(first.layout.tabs).toEqual([
		{ id: "file:src/app.ts", root: { type: "file", path: "src/app.ts" } },
	]);
	const again = openFile(first.layout, "src/app.ts");
	expect(again.layout).toBe(first.layout);
	expect(again.tabId).toBe(first.tabId);
});

test("the same path opens once as a file and once as a diff", () => {
	const file = openFile(emptyLayout(), "src/app.ts");
	const diff = openDiff(file.layout, "src/app.ts");
	expect(diff.tabId).toBe("diff:src/app.ts");
	expect(diff.layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
		"diff:src/app.ts",
	]);
});

test("a file leaf holds no terminal id and closeTab drops the whole tab", () => {
	const opened = openFile(emptyLayout(), "src/app.ts");
	expect(layoutTerminalIds(opened.layout)).toEqual([]);
	expect(closeTab(opened.layout, opened.tabId).tabs).toEqual([]);
	// Closing a tab that is not there leaves the layout alone.
	expect(closeTab(opened.layout, "file:other.ts")).toBe(opened.layout);
});

test("reconcile keeps file tabs while dropping terminals that are gone", () => {
	let layout = addTab(emptyLayout(), "a", "a");
	layout = openFile(layout, "src/app.ts").layout;
	const next = reconcile(layout, []);
	expect(next.tabs.map((tab) => tab.id)).toEqual(["file:src/app.ts"]);
});

test("a file leaf cannot be split or moved", () => {
	const layout = openFile(emptyLayout(), "src/app.ts").layout;
	expect(splitLeaf(layout, "src/app.ts", "row", "b")).toEqual(layout);
	expect(moveLeaf(layout, "file:src/app.ts", "src/app.ts", "a", "right")).toBe(layout);
	expect(moveLeafToNewTab(layout, "src/app.ts", 0, "fresh")).toBe(layout);
	// A pane dragged onto a file tab has nothing to drop into either.
	const mixed = addTab(layout, "a", "a");
	expect(moveLeaf(mixed, "file:src/app.ts", "a", "src/app.ts", "right")).toBe(mixed);
});
