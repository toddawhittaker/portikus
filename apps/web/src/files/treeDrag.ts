/**
 * The tree rows being dragged right now, in tree order: the one record, read
 * by the tree and by drop areas outside it (SPEC.md §9.3, §11.2). A browser
 * hides drag data until the drop, so a pane edge could not otherwise tell a
 * file from a folder while the drag is over it.
 */
import type { FileNode } from "./selection.js";

let current: readonly FileNode[] = [];

export function setDraggedTreeNodes(nodes: readonly FileNode[]): void {
	current = nodes;
}

export function draggedTreeNodes(): readonly FileNode[] {
	return current;
}
