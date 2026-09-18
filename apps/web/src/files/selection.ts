/**
 * Which rows of the file tree are selected (SPEC.md §11.2). Selecting is a
 * pure function of the click, the rows on screen in draw order, and what was
 * selected before, so the rules can be tested without a tree.
 *
 * Plain click selects one row. Ctrl-click (or Cmd-click) adds or removes one
 * row. Shift-click selects everything between the anchor and the clicked row.
 */

export interface Selection {
	/** The selected paths, in no particular order. */
	paths: readonly string[];
	/** The row a Shift-click measures from, or null when there is none. */
	anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { paths: [], anchor: null };

export interface ClickModifiers {
	/** Ctrl on Linux and Windows, Cmd on a Mac. */
	toggle: boolean;
	/** Shift: the contiguous run from the anchor. */
	range: boolean;
}

/** The paths from `from` to `to` in `order`, whichever way round they are. */
function run(order: readonly string[], from: string, to: string): string[] {
	const start = order.indexOf(from);
	const end = order.indexOf(to);
	if (start === -1 || end === -1) return [to];
	return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The selection after clicking `path` in a tree whose rows are `order`. */
export function selectionAfterClick(
	current: Selection,
	path: string,
	modifiers: ClickModifiers,
	order: readonly string[],
): Selection {
	if (modifiers.range && current.anchor !== null) {
		return { paths: run(order, current.anchor, path), anchor: current.anchor };
	}
	if (modifiers.toggle) {
		const has = current.paths.includes(path);
		return {
			paths: has ? current.paths.filter((p) => p !== path) : [...current.paths, path],
			anchor: path,
		};
	}
	return { paths: [path], anchor: path };
}

/**
 * The selection a row menu or the Delete key acts on: the whole selection
 * when the row is part of it, and otherwise just that row.
 */
export function actionTargets(selection: Selection, path: string): string[] {
	return selection.paths.includes(path) ? [...selection.paths] : [path];
}

/** Drop paths that are no longer drawn, so a deleted row stops being selected. */
export function pruneSelection(
	selection: Selection,
	order: readonly string[],
): Selection {
	const paths = selection.paths.filter((path) => order.includes(path));
	if (paths.length === selection.paths.length) return selection;
	return {
		paths,
		anchor:
			selection.anchor !== null && order.includes(selection.anchor)
				? selection.anchor
				: null,
	};
}

/** The selected paths in the order they are drawn, which is what a list shows. */
export function orderedSelection(
	selection: Selection,
	order: readonly string[],
): string[] {
	return order.filter((path) => selection.paths.includes(path));
}
