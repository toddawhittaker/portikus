/**
 * Where a drag is pointing (SPEC.md §8.3, §9.3). Kept away from React and
 * dnd-kit so the geometry can be tested on plain numbers.
 */
import type { DropEdge } from "../layout/tree.js";

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The middle third of a pane, in both directions, means swap. */
const CENTRE_FROM = 1 / 3;
const CENTRE_TO = 2 / 3;

/**
 * Which zone of a pane a pointer sits in: the nearest half-edge, or the
 * centre when it is in the middle third both across and down.
 */
export function dropZone(rect: Rect, x: number, y: number): DropEdge {
	if (rect.width <= 0 || rect.height <= 0) return "center";
	const across = (x - rect.left) / rect.width;
	const down = (y - rect.top) / rect.height;
	if (
		across > CENTRE_FROM &&
		across < CENTRE_TO &&
		down > CENTRE_FROM &&
		down < CENTRE_TO
	) {
		return "center";
	}
	const distances: [DropEdge, number][] = [
		["left", across],
		["right", 1 - across],
		["top", down],
		["bottom", 1 - down],
	];
	let nearest = distances[0] as [DropEdge, number];
	for (const candidate of distances) {
		if (candidate[1] < nearest[1]) nearest = candidate;
	}
	return nearest[0];
}

/**
 * Where a pane dropped on the tab strip would land: the number of tabs whose
 * midpoint the pointer has passed, so an empty strip gives 0 and a pointer
 * past the last tab gives the end.
 */
export function insertionIndex(
	tabs: { left: number; width: number }[],
	x: number,
): number {
	let index = 0;
	for (const tab of tabs) {
		if (x < tab.left + tab.width / 2) break;
		index += 1;
	}
	return index;
}
