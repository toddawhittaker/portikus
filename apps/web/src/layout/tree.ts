/**
 * Pure operations on a project's saved layout (SPEC.md §7.5, §9.3, §9.6).
 * A layout is a list of tabs, each holding a tree of splits whose leaves are
 * terminal ids. Nothing here touches React or the network, so every rule
 * about splitting, collapsing and reconciling can be tested on its own.
 */
import type { ProjectLayout, SplitNode } from "@portikus/contracts";

export type SplitDirection = "row" | "column";

export function emptyLayout(): ProjectLayout {
	return { tabs: [] };
}

/** Every terminal id in the subtree, in visual order. */
export function leafIds(node: SplitNode): string[] {
	if (node.type === "leaf") return [node.terminalId];
	return node.children.flatMap(leafIds);
}

/** Every terminal id in the layout, in tab order. */
export function layoutTerminalIds(layout: ProjectLayout): string[] {
	return layout.tabs.flatMap((tab) => leafIds(tab.root));
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Equal sizes that add up to exactly 100, so a saved layout stays normalised. */
export function evenSizes(count: number): number[] {
	const each = round2(100 / count);
	const sizes = Array.from({ length: count }, () => each);
	sizes[count - 1] = round2(100 - each * (count - 1));
	return sizes;
}

/** Scale sizes so they add up to 100; falls back to even sizes if they cannot. */
export function normaliseSizes(sizes: number[]): number[] {
	const total = sizes.reduce((sum, size) => sum + (size > 0 ? size : 0), 0);
	if (total <= 0) return evenSizes(sizes.length);
	const scaled = sizes.map((size) => round2(((size > 0 ? size : 0) / total) * 100));
	const last = scaled.length - 1;
	scaled[last] = round2(
		100 - scaled.slice(0, last).reduce((sum, size) => sum + size, 0),
	);
	return scaled;
}

/** A new tab holding one terminal, appended to the end. */
export function addTab(
	layout: ProjectLayout,
	terminalId: string,
	tabId: string,
): ProjectLayout {
	return {
		tabs: [...layout.tabs, { id: tabId, root: { type: "leaf", terminalId } }],
	};
}

function splitNode(
	node: SplitNode,
	terminalId: string,
	direction: SplitDirection,
	newTerminalId: string,
): SplitNode | null {
	if (node.type === "leaf") {
		if (node.terminalId !== terminalId) return null;
		return {
			type: "split",
			direction,
			sizes: evenSizes(2),
			children: [node, { type: "leaf", terminalId: newTerminalId }],
		};
	}
	const index = node.children.findIndex(
		(child) => child.type === "leaf" && child.terminalId === terminalId,
	);
	if (index >= 0 && node.direction === direction) {
		const children = [...node.children];
		children.splice(index + 1, 0, { type: "leaf", terminalId: newTerminalId });
		return { ...node, children, sizes: evenSizes(children.length) };
	}
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child === undefined) continue;
		const replaced = splitNode(child, terminalId, direction, newTerminalId);
		if (!replaced) continue;
		const children = [...node.children];
		children[i] = replaced;
		return { ...node, children };
	}
	return null;
}

/**
 * Put `newTerminalId` beside `terminalId`. When the enclosing split already
 * runs in the same direction the new pane joins it as a sibling and the sizes
 * are shared out evenly; otherwise the leaf becomes a split of two.
 */
export function splitLeaf(
	layout: ProjectLayout,
	terminalId: string,
	direction: SplitDirection,
	newTerminalId: string,
): ProjectLayout {
	return {
		tabs: layout.tabs.map((tab) => {
			const root = splitNode(tab.root, terminalId, direction, newTerminalId);
			return root ? { ...tab, root } : tab;
		}),
	};
}

/** `"unchanged"` when this subtree did not hold the terminal, null when it is now empty. */
function removeFromNode(
	node: SplitNode,
	terminalId: string,
): SplitNode | null | "unchanged" {
	if (node.type === "leaf") {
		return node.terminalId === terminalId ? null : "unchanged";
	}
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child === undefined) continue;
		const result = removeFromNode(child, terminalId);
		if (result === "unchanged") continue;
		const children = [...node.children];
		const sizes = [...node.sizes];
		if (result === null) {
			children.splice(i, 1);
			sizes.splice(i, 1);
		} else {
			children[i] = result;
		}
		if (children.length === 0) return null;
		const only = children[0];
		if (children.length === 1 && only !== undefined) return only;
		return { ...node, children, sizes: normaliseSizes(sizes) };
	}
	return "unchanged";
}

/**
 * Drop one terminal. A split left with a single child collapses into it, and
 * a tab left with nothing disappears.
 */
export function removeLeaf(layout: ProjectLayout, terminalId: string): ProjectLayout {
	const tabs: ProjectLayout["tabs"] = [];
	for (const tab of layout.tabs) {
		const root = removeFromNode(tab.root, terminalId);
		if (root === "unchanged") {
			tabs.push(tab);
			continue;
		}
		if (root === null) continue;
		tabs.push({ ...tab, root });
	}
	return { tabs };
}

/** Swap one terminal id for another, keeping the pane where it is (SPEC.md §6.8). */
export function replaceLeaf(
	layout: ProjectLayout,
	terminalId: string,
	newTerminalId: string,
): ProjectLayout {
	function walk(node: SplitNode): SplitNode {
		if (node.type === "leaf") {
			return node.terminalId === terminalId
				? { type: "leaf", terminalId: newTerminalId }
				: node;
		}
		return { ...node, children: node.children.map(walk) };
	}
	return { tabs: layout.tabs.map((tab) => ({ ...tab, root: walk(tab.root) })) };
}

/** Move a tab from one position to another; out-of-range moves are ignored. */
export function moveTab(
	layout: ProjectLayout,
	from: number,
	to: number,
): ProjectLayout {
	if (from === to) return layout;
	if (from < 0 || from >= layout.tabs.length) return layout;
	if (to < 0 || to >= layout.tabs.length) return layout;
	const tabs = [...layout.tabs];
	const [moved] = tabs.splice(from, 1);
	if (moved === undefined) return layout;
	tabs.splice(to, 0, moved);
	return { tabs };
}

/**
 * Record new pane sizes for the split at `path`, where the path is the list
 * of child indices from the tab root.
 */
export function resize(
	layout: ProjectLayout,
	tabId: string,
	path: number[],
	sizes: number[],
): ProjectLayout {
	function walk(node: SplitNode, depth: number): SplitNode {
		if (node.type !== "split") return node;
		if (depth === path.length) {
			if (sizes.length !== node.children.length) return node;
			return { ...node, sizes: normaliseSizes(sizes) };
		}
		const index = path[depth];
		if (index === undefined) return node;
		const child = node.children[index];
		if (child === undefined) return node;
		const children = [...node.children];
		children[index] = walk(child, depth + 1);
		return { ...node, children };
	}
	return {
		tabs: layout.tabs.map((tab) =>
			tab.id === tabId ? { ...tab, root: walk(tab.root, 0) } : tab,
		),
	};
}

/**
 * Bring the layout back in line with the terminals the server knows about:
 * a terminal with no pane gets a tab of its own, and a pane whose terminal is
 * gone is removed. Ended terminals are still terminals, so their panes stay
 * (SPEC.md §6.8).
 */
export function reconcile(layout: ProjectLayout, terminalIds: string[]): ProjectLayout {
	let next = layout;
	const known = new Set(terminalIds);
	for (const id of layoutTerminalIds(layout)) {
		if (!known.has(id)) next = removeLeaf(next, id);
	}
	const placed = new Set(layoutTerminalIds(next));
	for (const id of terminalIds) {
		if (placed.has(id)) continue;
		next = addTab(next, id, id);
		placed.add(id);
	}
	return next;
}
