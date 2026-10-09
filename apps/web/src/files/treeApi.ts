import { createContext, type DragEvent, useContext } from "react";
import type { GitDecorations } from "./gitStatus.js";
import type { RowStateStore } from "./rowState.js";
import type { ClickModifiers, FileNode } from "./selection.js";
import type { TreeFocusHandlers } from "./treeKeys.js";

export interface TreeApi {
	workspaceId: string;
	projectId: string;
	showHidden: boolean;
	expanded: string[];
	toggle: (path: string) => void;
	setOpen: (path: string, open: boolean) => void;
	openFile: (node: FileNode) => void;
	newIn: (dir: string, kind: "file" | "dir") => void;
	rename: (node: FileNode) => void;
	move: (node: FileNode) => void;
	remove: (node: FileNode) => void;
	uploadInto: (dir: string, files: FileList | File[]) => void;
	pickUpload: (dir: string) => void;
	/** The focused row and the selection, read per row (rowState.ts). */
	rowState: RowStateStore;
	setFocusedPath: (path: string | null) => void;
	/** The row elements on screen, in the order they are drawn. */
	rowElements: () => HTMLElement[];
	/** The rows on screen, in the order they are drawn. */
	visibleNodes: () => FileNode[];
	/** Moves the Tab stop to a row on screen if the focused one is gone. */
	repairFocus: () => void;
	/** Whether the tree holds focus, so a repair knows to move it. */
	treeFocusHandlers: TreeFocusHandlers;
	clickRow: (path: string, modifiers: ClickModifiers) => void;
	/** Shift+Arrow: run the selection from the anchor to `to`. */
	extendTo: (from: string, to: string) => void;
	/** The rows an action on `path` applies to: the selection, or that row. */
	targetsFor: (node: FileNode) => FileNode[];
	download: (nodes: readonly FileNode[]) => void;
	/** "Extract here" on a zip, into a new folder beside it. */
	extract: (node: FileNode) => void;
	/** The element holding the rows, so the drawn order can be read back. */
	treeRef: (element: HTMLElement | null) => void;
	/** Drag a row to another folder (SPEC.md §11.2). */
	startMove: (event: DragEvent, node: FileNode) => void;
	endMove: () => void;
	/** Git decorations for the rows (SPEC.md §12.1). */
	git: GitDecorations;
	/** The row whose ⋯ menu is open, so the keyboard can open it. */
	menuPath: string | null;
	setMenuPath: (path: string | null) => void;
	/** Say something in the pane's polite status region. */
	announce: (text: string) => void;
}

export const TreeContext = createContext<TreeApi | null>(null);

export function useTreeApi(): TreeApi {
	const api = useContext(TreeContext);
	if (!api) throw new Error("the file tree row is outside its tree");
	return api;
}
