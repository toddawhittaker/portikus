/**
 * Drag and drop for the file tree (SPEC.md §11.2): rows dragged onto a folder
 * move there, and files dragged in from the desktop upload into the folder
 * under the pointer. Both use the browser's own drag and drop, so a row costs
 * no per-row registration and loading more rows redraws none of the others.
 * The Move to dialog is the keyboard way to do the same (WCAG 2.5.7).
 */
import { type DragEvent, useCallback, useRef, useState } from "react";
import { moveForDrop } from "./paths.js";
import type { RowStateStore } from "./rowState.js";
import type { FileNode } from "./selection.js";

/**
 * The type a dragged row carries. Private, so a row dropped on the editor, a
 * terminal or another site inserts nothing; the browser lower-cases types.
 */
export const TREE_DRAG_TYPE = "application/x-portikus-tree-path";

/** The folder under the pointer, from the nearest `data-drop-dir`; null over none. */
function dirUnder(target: EventTarget | null): string | null {
	const element = target instanceof Element ? target.closest("[data-drop-dir]") : null;
	return element?.getAttribute("data-drop-dir") ?? null;
}

function dragKind(event: DragEvent): "move" | "upload" | null {
	const { types } = event.dataTransfer;
	if (types.includes(TREE_DRAG_TYPE)) return "move";
	if (types.includes("Files")) return "upload";
	return null;
}

export function useTreeDragAndDrop({
	rowState,
	moveFile,
	afterMove,
	fail,
	uploadInto,
}: {
	rowState: RowStateStore;
	/** Resolves false when the student declined to replace a file. */
	moveFile: (from: string, to: string, isDir: boolean) => Promise<boolean>;
	afterMove: (from: string, to: string) => void;
	fail: (error: unknown) => void;
	uploadInto: (dir: string, files: FileList) => void;
}) {
	const [uploadDrag, setUploadDrag] = useState(false);
	// How many pane elements the drag is currently inside. Moving onto a child
	// row fires a leave for the element behind it, so counting is the only way
	// to tell "moved within the pane" from "left the pane".
	const depth = useRef(0);
	// The row in flight. The drag data cannot be read until the drop, so the
	// folder under the pointer is checked against this instead.
	const dragged = useRef<FileNode | null>(null);

	function setDropDir(dropDir: string | null) {
		if (rowState.getState().dropDir !== dropDir) rowState.setState({ dropDir });
	}

	// Stable, like startMove, because every row is handed it.
	const reset = useCallback(() => {
		depth.current = 0;
		dragged.current = null;
		rowState.setState({ draggedPath: null, dropDir: null });
		setUploadDrag(false);
	}, [rowState]);

	/** The folder a drag over `target` would land in, or null where it cannot land. */
	function landing(kind: "move" | "upload", target: EventTarget | null): string | null {
		const dir = dirUnder(target);
		// An upload anywhere else in the pane goes to the project root.
		if (kind === "upload") return dir ?? "";
		const from = dragged.current;
		return from && moveForDrop(from.path, dir) ? dir : null;
	}

	/** On a row: start carrying it. */
	const startMove = useCallback(
		(event: DragEvent, node: FileNode) => {
			event.dataTransfer.setData(TREE_DRAG_TYPE, node.path);
			event.dataTransfer.effectAllowed = "move";
			dragged.current = node;
			rowState.setState({ draggedPath: node.path });
		},
		[rowState],
	);

	/** On the pane: where a drag is, and what a drop does. */
	const paneHandlers = {
		onDragEnter: (event: DragEvent) => {
			const kind = dragKind(event);
			if (!kind) return;
			depth.current += 1;
			if (kind === "upload") setUploadDrag(true);
			setDropDir(landing(kind, event.target));
		},
		onDragOver: (event: DragEvent) => {
			const kind = dragKind(event);
			if (!kind) return;
			const dir = landing(kind, event.target);
			setDropDir(dir);
			// Only a place that accepts the drop cancels the browser's refusal.
			if (dir === null) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = kind === "move" ? "move" : "copy";
		},
		onDragLeave: () => {
			if (depth.current === 0) return;
			depth.current -= 1;
			if (depth.current > 0) return;
			setDropDir(null);
			setUploadDrag(false);
		},
		onDrop: (event: DragEvent) => {
			const kind = dragKind(event);
			if (!kind) return;
			const dir = landing(kind, event.target);
			const node = dragged.current;
			reset();
			if (dir === null) return;
			event.preventDefault();
			if (kind === "upload") {
				if (event.dataTransfer.files.length) uploadInto(dir, event.dataTransfer.files);
				return;
			}
			const move = node ? moveForDrop(node.path, dir) : null;
			if (!node || !move) return;
			void moveFile(move.from, move.to, node.isDir)
				.then((moved) => {
					if (moved) afterMove(move.from, move.to);
				})
				.catch(fail);
		},
	};

	// A drag ends on its source row, dropped or not.
	return { uploadDrag, startMove, endMove: reset, paneHandlers };
}
