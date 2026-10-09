/**
 * The tree row being dragged right now, for drop areas outside the tree
 * (SPEC.md §9.3). A browser hides drag data until the drop, so a pane edge
 * could not otherwise tell a file from a folder while the drag is over it.
 */
import type { FileNode } from "./selection.js";

let current: FileNode | null = null;

export function setDraggedTreeNode(node: FileNode | null): void {
	current = node;
}

export function draggedTreeNode(): FileNode | null {
	return current;
}
