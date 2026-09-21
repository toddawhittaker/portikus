/**
 * Pure operations on a project's saved layout (SPEC.md §7.5, §9.3, §9.6).
 * A layout is a list of tabs, each holding a tree of splits whose leaves are
 * terminal ids. Nothing here touches React or the network, so every rule
 * about splitting, collapsing and reconciling can be tested on its own.
 */
import {
	MAX_SPLIT_DEPTH,
	type ProjectLayout,
	type SplitNode,
	splitDepth,
} from "@portikus/contracts";

export type SplitDirection = "row" | "column";

export function emptyLayout(): ProjectLayout {
	return { tabs: [] };
}

/** Every terminal id in the subtree, in visual order. File and diff leaves have none. */
export function terminalIds(node: SplitNode): string[] {
	if (node.type === "leaf") return [node.terminalId];
	if (node.type !== "split") return [];
	return node.children.flatMap(terminalIds);
}

/** Every terminal id in the layout, in tab order. */
export function layoutTerminalIds(layout: ProjectLayout): string[] {
	return layout.tabs.flatMap((tab) => terminalIds(tab.root));
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
	// Only terminals split (SPEC.md §8.3), so a file or diff leaf is left alone.
	if (node.type !== "split") return null;
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
	if (node.type !== "split") return "unchanged";
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
		if (node.type !== "split") return node;
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
 * a live terminal with no pane gets a tab of its own, and a pane whose
 * terminal is gone is removed. Ended terminals are still terminals, so their
 * panes stay (SPEC.md §6.8). An ended terminal with no pane is history in the
 * listing (SPEC.md §9.7) - a revive swapped it out of the layout - so it is
 * left alone rather than given a tab back.
 */
export function reconcile(
	layout: ProjectLayout,
	terminalIds: string[],
	endedIds: Iterable<string> = [],
): ProjectLayout {
	let next = layout;
	const known = new Set(terminalIds);
	const ended = new Set(endedIds);
	for (const id of layoutTerminalIds(layout)) {
		if (!known.has(id)) next = removeLeaf(next, id);
	}
	const placed = new Set(layoutTerminalIds(next));
	for (const id of terminalIds) {
		if (placed.has(id) || ended.has(id)) continue;
		next = addTab(next, id, id);
		placed.add(id);
	}
	return next;
}

/** Which half-edge of a pane a drag landed on; centre means swap the two. */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

function withinDepth(layout: ProjectLayout): boolean {
	return layout.tabs.every((tab) => splitDepth(tab.root) <= MAX_SPLIT_DEPTH);
}

/** Exchange the places of two leaves, wherever in the layout they sit. */
function swapLeaves(layout: ProjectLayout, a: string, b: string): ProjectLayout {
	function walk(node: SplitNode): SplitNode {
		if (node.type === "leaf") {
			if (node.terminalId === a) return { type: "leaf", terminalId: b };
			if (node.terminalId === b) return { type: "leaf", terminalId: a };
			return node;
		}
		if (node.type !== "split") return node;
		return { ...node, children: node.children.map(walk) };
	}
	return { tabs: layout.tabs.map((tab) => ({ ...tab, root: walk(tab.root) })) };
}

/** Null when this subtree does not hold `targetId`. */
function insertBeside(
	node: SplitNode,
	targetId: string,
	terminalId: string,
	direction: SplitDirection,
	before: boolean,
): SplitNode | null {
	if (node.type === "leaf") {
		if (node.terminalId !== targetId) return null;
		const moved: SplitNode = { type: "leaf", terminalId };
		return {
			type: "split",
			direction,
			sizes: evenSizes(2),
			children: before ? [moved, node] : [node, moved],
		};
	}
	if (node.type !== "split") return null;
	const index = node.children.findIndex(
		(child) => child.type === "leaf" && child.terminalId === targetId,
	);
	if (index >= 0 && node.direction === direction) {
		const children = [...node.children];
		children.splice(before ? index : index + 1, 0, { type: "leaf", terminalId });
		return { ...node, children, sizes: evenSizes(children.length) };
	}
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child === undefined) continue;
		const replaced = insertBeside(child, targetId, terminalId, direction, before);
		if (!replaced) continue;
		const children = [...node.children];
		children[i] = replaced;
		return { ...node, children };
	}
	return null;
}

/**
 * Drag one pane onto another (SPEC.md §9.3). The edge says where it lands:
 * left and top insert before the target, right and bottom after, and centre
 * swaps the two panes. A tab left empty by the move disappears. A move that
 * would make a tab deeper than `MAX_SPLIT_DEPTH` is refused, and the layout
 * comes back unchanged.
 */
export function moveLeaf(
	layout: ProjectLayout,
	tabId: string,
	terminalId: string,
	targetTerminalId: string,
	edge: DropEdge,
): ProjectLayout {
	if (terminalId === targetTerminalId) return layout;
	const present = new Set(layoutTerminalIds(layout));
	if (!present.has(terminalId) || !present.has(targetTerminalId)) return layout;
	const target = layout.tabs.find(
		(tab) => tab.id === tabId && terminalIds(tab.root).includes(targetTerminalId),
	);
	if (!target) return layout;

	if (edge === "center") return swapLeaves(layout, terminalId, targetTerminalId);

	const direction: SplitDirection =
		edge === "left" || edge === "right" ? "row" : "column";
	const before = edge === "left" || edge === "top";
	let inserted = false;
	const tabs = removeLeaf(layout, terminalId).tabs.map((tab) => {
		if (tab.id !== tabId) return tab;
		const root = insertBeside(
			tab.root,
			targetTerminalId,
			terminalId,
			direction,
			before,
		);
		if (!root) return tab;
		inserted = true;
		return { ...tab, root };
	});
	if (!inserted) return layout;
	const next = { tabs };
	return withinDepth(next) ? next : layout;
}

/**
 * Drag one pane out to the tab strip (SPEC.md §8.3): it leaves its tab and
 * becomes a tab of its own at `index`, under the `tabId` the caller supplies.
 * The id comes from the caller because the terminal id is already in use as
 * the name of the tab this pane is leaving. A tab left empty disappears.
 */
export function moveLeafToNewTab(
	layout: ProjectLayout,
	terminalId: string,
	index: number,
	tabId: string,
): ProjectLayout {
	if (!layoutTerminalIds(layout).includes(terminalId)) return layout;
	const tabs = removeLeaf(layout, terminalId).tabs;
	const next = [...tabs];
	next.splice(Math.min(Math.max(index, 0), next.length), 0, {
		id: tabId,
		root: { type: "leaf", terminalId },
	});
	return { tabs: next };
}

/**
 * Open `path` as a tab of its own (SPEC.md §8.3). A path already open is not
 * opened twice; the caller activates the tab it gets back. A diff is a view
 * of this tab, not a tab of its own (issue #160).
 */
export function openFile(
	layout: ProjectLayout,
	path: string,
): { layout: ProjectLayout; tabId: string } {
	const tabId = fileTabId(path);
	if (layout.tabs.some((tab) => tab.id === tabId)) return { layout, tabId };
	const node: SplitNode = { type: "file", path };
	return { layout: { tabs: [...layout.tabs, { id: tabId, root: node }] }, tabId };
}

/** The id of the one tab that shows `path`. */
export function fileTabId(path: string): string {
	return `file:${path}`;
}

/** The id of the one tab that previews `port` (SPEC.md §14.6). */
export function previewTabId(port: number): string {
	return `preview:${port}`;
}

/**
 * Open a preview of `port` as a tab of its own (SPEC.md §14.6). A port
 * already open is not opened twice; the caller activates the tab it gets
 * back. There is no limit on open tabs (issue #240).
 */
export function openPreview(
	layout: ProjectLayout,
	port: number,
): { layout: ProjectLayout; tabId: string } {
	const tabId = previewTabId(port);
	if (layout.tabs.some((tab) => tab.id === tabId)) return { layout, tabId };
	const node: SplitNode = { type: "preview", port };
	return { layout: { tabs: [...layout.tabs, { id: tabId, root: node }] }, tabId };
}

/**
 * Turn the diff tabs of a layout saved by an older version into file tabs,
 * so one path has one tab. The ids of the tabs that were diffs come back as
 * well, because those tabs should open showing their diff.
 */
export function migrateDiffTabs(layout: ProjectLayout): {
	layout: ProjectLayout;
	diffTabIds: string[];
} {
	if (!layout.tabs.some((tab) => tab.root.type === "diff")) {
		return { layout, diffTabIds: [] };
	}
	const tabs: ProjectLayout["tabs"] = [];
	const diffTabIds: string[] = [];
	for (const tab of layout.tabs) {
		if (tab.root.type !== "diff") {
			if (!tabs.some((kept) => kept.id === tab.id)) tabs.push(tab);
			continue;
		}
		const id = fileTabId(tab.root.path);
		diffTabIds.push(id);
		// The same path may already have a file tab; it keeps its place.
		if (tabs.some((kept) => kept.id === id)) continue;
		tabs.push({ id, root: { type: "file", path: tab.root.path } });
	}
	return { layout: { tabs }, diffTabIds };
}

/** Drop one whole tab. Terminal tabs are closed by closing their terminals. */
export function closeTab(layout: ProjectLayout, tabId: string): ProjectLayout {
	if (!layout.tabs.some((tab) => tab.id === tabId)) return layout;
	return { tabs: layout.tabs.filter((tab) => tab.id !== tabId) };
}
