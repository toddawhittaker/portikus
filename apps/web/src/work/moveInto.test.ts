import {
	MAX_SPLIT_DEPTH,
	type ProjectLayout,
	type SplitNode,
} from "@portikus/contracts";
import { expect, test } from "vitest";
import { moveLeaf } from "../layout/tree.js";
import { moveIntoTargets } from "./moveInto.js";

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

test("offers every other terminal tab, in tab order, beside its last pane", () => {
	expect(moveIntoTargets(layout, "t1")).toEqual([
		{ tabId: "b", terminalId: "t3", edge: "right" },
		{ tabId: "c", terminalId: "t4", edge: "right" },
	]);
});

test("never offers the pane's own tab", () => {
	expect(moveIntoTargets(layout, "t2").map((target) => target.tabId)).toEqual([
		"a",
		"c",
	]);
});

test("moving into a target joins that tab's split, as the drag does", () => {
	const [target] = moveIntoTargets(layout, "t4").filter((t) => t.tabId === "b");
	if (!target) throw new Error("tab b was not offered");
	const next = moveLeaf(layout, target.tabId, "t4", target.terminalId, target.edge);
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

test("a pane with no other terminal tab has nowhere to go", () => {
	expect(moveIntoTargets({ tabs: [{ id: "a", root: leaf("t1") }] }, "t1")).toEqual([]);
});
