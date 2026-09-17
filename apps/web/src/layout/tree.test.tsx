import type { ProjectLayout, SplitNode } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	addTab,
	emptyLayout,
	evenSizes,
	layoutTerminalIds,
	leafIds,
	moveTab,
	normaliseSizes,
	reconcile,
	removeLeaf,
	replaceLeaf,
	resize,
	splitLeaf,
	tabIdOf,
} from "./tree";

function leaf(id: string): SplitNode {
	return { type: "leaf", terminalId: id };
}

function oneTab(root: SplitNode, id = "tab1"): ProjectLayout {
	return { tabs: [{ id, root }] };
}

/** Sizes must always add up to 100 so a reload restores the same picture. */
function sumsTo100(node: SplitNode): boolean {
	if (node.type === "leaf") return true;
	const total = node.sizes.reduce((sum, size) => sum + size, 0);
	return Math.abs(total - 100) < 0.001 && node.children.every(sumsTo100);
}

test("a new tab holds one terminal and goes last", () => {
	const layout = addTab(addTab(emptyLayout(), "a", "t1"), "b", "t2");
	expect(layout.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
	expect(layoutTerminalIds(layout)).toEqual(["a", "b"]);
	expect(tabIdOf(layout, "b")).toBe("t2");
	expect(tabIdOf(layout, "zz")).toBeNull();
});

test("splitting a lone leaf right makes a row of two equal panes", () => {
	const layout = splitLeaf(oneTab(leaf("a")), "a", "row", "b");
	const root = layout.tabs[0]?.root as Extract<SplitNode, { type: "split" }>;
	expect(root.direction).toBe("row");
	expect(root.sizes).toEqual([50, 50]);
	expect(leafIds(root)).toEqual(["a", "b"]);
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
	expect(leafIds(root)).toEqual(["a", "b", "c"]);
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
	expect(leafIds(nested)).toEqual(["b", "c"]);
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
	expect(leafIds(root)).toEqual(["a", "c"]);
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
	let next = 0;
	const layout = reconcile(emptyLayout(), ["a", "b"], () => `t${++next}`);
	expect(layout.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
	expect(layoutTerminalIds(layout)).toEqual(["a", "b"]);
});

test("reconcile prunes a pane whose terminal is gone but keeps the rest", () => {
	const layout = reconcile(
		splitLeaf(oneTab(leaf("a")), "a", "row", "b"),
		["a"],
		() => "new",
	);
	expect(layout.tabs[0]?.root).toEqual(leaf("a"));
});

test("reconcile keeps an ended terminal, because it is still in the list", () => {
	const layout = reconcile(oneTab(leaf("a")), ["a"], () => "new");
	expect(layoutTerminalIds(layout)).toEqual(["a"]);
});

test("reconcile with nothing to do returns the same layout", () => {
	const layout = oneTab(leaf("a"));
	expect(reconcile(layout, ["a"], () => "new")).toBe(layout);
});
