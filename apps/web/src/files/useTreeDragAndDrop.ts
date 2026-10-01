/**
 * Drag and drop for the file tree (SPEC.md §11.2): rows dragged onto a folder
 * move there, and files dragged in from the desktop upload into the folder
 * under the pointer.
 */
import {
	type DragEndEvent,
	type DragStartEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { type DragEvent, useRef, useState } from "react";
import { moveForDrop } from "./paths.js";

/** The droppable id of a directory; the project root is the empty path. */
export const dropId = (dir: string) => `dir:${dir}`;

/**
 * The empty area below the tree is a second way into the project root
 * (issue #237). It is its own element rather than the pane body, so it never
 * overlaps a row and the pointer can only be over one of the two.
 */
export const ROOT_SPACE_DROP_ID = "root-space";

/** Which directory a desktop drag is over, from the row under the pointer. */
function dirUnder(target: EventTarget | null): string {
	const element = target instanceof Element ? target.closest("[data-drop-dir]") : null;
	return element?.getAttribute("data-drop-dir") ?? "";
}

export function useTreeDragAndDrop({
	moveFile,
	afterMove,
	fail,
	uploadInto,
}: {
	moveFile: (from: string, to: string) => Promise<unknown>;
	afterMove: (from: string, to: string) => void;
	fail: (error: unknown) => void;
	uploadInto: (dir: string, files: FileList) => void;
}) {
	const [dropDir, setDropDir] = useState<string | null>(null);
	const [uploadDrag, setUploadDrag] = useState(false);
	// How many pane elements the upload drag is currently inside. Moving onto a
	// child row fires a leave for the element behind it, so counting is the only
	// way to tell "moved within the pane" from "left the pane" (issue #220).
	const uploadDepth = useRef(0);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);
	// What the pointer is carrying, so the drag has something visible to show
	// (issue #237). dnd-kit draws it in a DragOverlay at the pointer.
	const [dragged, setDragged] = useState<{ path: string; isDir: boolean } | null>(null);

	function onDragStart(event: DragStartEvent) {
		const id = String(event.active.id);
		if (!id.startsWith("row:")) return;
		setDragged({
			path: id.slice("row:".length),
			isDir: event.active.data.current?.isDir === true,
		});
	}

	function onDragEnd(event: DragEndEvent) {
		setDropDir(null);
		setDragged(null);
		const over = event.over ? String(event.over.id) : null;
		const move = moveForDrop(
			String(event.active.id),
			// The empty space below the tree means the project root.
			over === ROOT_SPACE_DROP_ID ? dropId("") : over,
		);
		if (!move) return;
		const { from, to } = move;
		void moveFile(from, to)
			.then(() => afterMove(from, to))
			.catch(fail);
	}

	function onDragCancel() {
		setDropDir(null);
		setDragged(null);
	}

	/** Desktop drag-and-drop upload onto the pane body. */
	const uploadHandlers = {
		onDragOver: (event: DragEvent) => {
			if (!event.dataTransfer.types.includes("Files")) return;
			event.preventDefault();
			setUploadDrag(true);
			setDropDir(dirUnder(event.target));
		},
		onDragEnter: (event: DragEvent) => {
			if (!event.dataTransfer.types.includes("Files")) return;
			uploadDepth.current += 1;
			setUploadDrag(true);
			setDropDir(dirUnder(event.target));
		},
		onDragLeave: () => {
			if (uploadDepth.current === 0) return;
			uploadDepth.current -= 1;
			if (uploadDepth.current > 0) return;
			setDropDir(null);
			setUploadDrag(false);
		},
		onDrop: (event: DragEvent) => {
			if (!event.dataTransfer.files.length) return;
			event.preventDefault();
			const dir = dirUnder(event.target);
			uploadDepth.current = 0;
			setDropDir(null);
			setUploadDrag(false);
			uploadInto(dir, event.dataTransfer.files);
		},
	};

	return {
		sensors,
		dragged,
		dropDir,
		uploadDrag,
		dndHandlers: { onDragStart, onDragEnd, onDragCancel },
		uploadHandlers,
	};
}
