/**
 * The per-file state the layout store keeps beside the layout: what each open
 * file pane shows and where its editor was. It follows files as they close
 * and move.
 */
import { isDescendant, movedPath } from "../files/paths.js";
import type { LayoutState } from "./store.js";
import * as tree from "./tree.js";

/** Drop the per-file state of files that are no longer open. */
export function forgetFiles(
	state: LayoutState,
	paths: string[],
): Pick<
	LayoutState,
	"pendingView" | "diffBaseline" | "viewStates" | "zooms" | "fileViews"
> {
	const pendingView = { ...state.pendingView };
	const diffBaseline = { ...state.diffBaseline };
	const viewStates = { ...state.viewStates };
	const zooms = { ...state.zooms };
	const fileViews = { ...state.fileViews };
	for (const path of paths) {
		const id = tree.fileTabId(path);
		delete pendingView[id];
		delete diffBaseline[id];
		delete viewStates[path];
		delete zooms[path];
		delete fileViews[path];
	}
	return { pendingView, diffBaseline, viewStates, zooms, fileViews };
}

/**
 * Rewrite the keys of a per-file record after `from` moved to `to`. `prefix`
 * is what comes before the path in a key. Whatever was kept for a file the
 * move replaced at `to` is dropped.
 */
export function moveKeys<T>(
	record: Record<string, T>,
	prefix: string,
	from: string,
	to: string,
): Record<string, T> {
	const kept: Record<string, T> = {};
	const moved: Record<string, T> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!key.startsWith(prefix)) {
			kept[key] = value;
			continue;
		}
		const path = key.slice(prefix.length);
		const now = movedPath(path, from, to);
		if (now !== null) moved[prefix + now] = value;
		else if (path !== to && !isDescendant(path, to)) kept[key] = value;
	}
	return { ...kept, ...moved };
}
