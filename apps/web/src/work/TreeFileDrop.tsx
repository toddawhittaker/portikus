/**
 * A file dragged from the tree onto a pane's edge opens there as a split, or
 * moves its pane there when it is already open (SPEC.md §9.3). The tree uses
 * the browser's own drag and drop while panes use dnd-kit, so this listens
 * for native drags on the work area and finds the pane under the pointer
 * among dnd-kit's drop areas. The keyboard way is the pane's Move into menu.
 */
import { useDndContext } from "@dnd-kit/core";
import type { ProjectLayout } from "@portikus/contracts";
import { type RefObject, useEffect, useRef } from "react";
import { draggedTreeNode } from "../files/treeDrag.js";
import { TREE_DRAG_TYPE } from "../files/useTreeDragAndDrop.js";
import { dropZone } from "./dropZone.js";
import { fileDropTarget, type MoveIntoTarget } from "./moveInto.js";

export interface TreeFileDropProps {
	/** The element whose panes take the drop. */
	area: RefObject<HTMLElement | null>;
	layout: ProjectLayout;
	/** Where a drop would land now, for the edge highlight; null over nothing. */
	onTarget: (target: MoveIntoTarget | null) => void;
	onDrop: (path: string, target: MoveIntoTarget) => void;
}

export function TreeFileDrop({ area, layout, onTarget, onDrop }: TreeFileDropProps) {
	const { droppableContainers } = useDndContext();
	// The listeners are added once; these keep them reading the newest values.
	const latest = useRef({ layout, onTarget, onDrop, droppableContainers });
	latest.current = { layout, onTarget, onDrop, droppableContainers };

	useEffect(() => {
		const element = area.current;
		if (!element) return;
		let shown: MoveIntoTarget | null = null;

		function show(target: MoveIntoTarget | null) {
			if (
				shown?.paneId === target?.paneId &&
				shown?.edge === target?.edge &&
				shown?.tabId === target?.tabId
			) {
				return;
			}
			shown = target;
			latest.current.onTarget(target);
		}

		/** The landing for a tree file drag at this event, or null. */
		function targetOf(
			event: DragEvent,
		): { path: string; target: MoveIntoTarget } | null {
			if (!event.dataTransfer?.types.includes(TREE_DRAG_TYPE)) return null;
			const node = draggedTreeNode();
			if (!node || node.isDir) return null;
			if (!(event.target instanceof Node)) return null;
			for (const container of latest.current.droppableContainers.values()) {
				const pane = container.node.current;
				const paneId = container.data.current?.paneId;
				if (!pane || typeof paneId !== "string" || !pane.contains(event.target)) {
					continue;
				}
				const edge = dropZone(
					pane.getBoundingClientRect(),
					event.clientX,
					event.clientY,
				);
				const target = fileDropTarget(latest.current.layout, node.path, paneId, edge);
				return target ? { path: node.path, target } : null;
			}
			return null;
		}

		function onDragOver(event: DragEvent) {
			const found = targetOf(event);
			show(found?.target ?? null);
			if (!found) return;
			event.preventDefault();
			// The tree allows only a move.
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		}

		function onDragLeave(event: DragEvent) {
			const next = event.relatedTarget;
			if (next instanceof Node && element?.contains(next)) return;
			show(null);
		}

		function onDrop(event: DragEvent) {
			const found = targetOf(event);
			show(null);
			if (!found) return;
			// An editor under the pointer must not take the drop as well.
			event.preventDefault();
			event.stopPropagation();
			latest.current.onDrop(found.path, found.target);
		}

		function onDragEnd() {
			show(null);
		}

		element.addEventListener("dragover", onDragOver, true);
		element.addEventListener("dragleave", onDragLeave, true);
		element.addEventListener("drop", onDrop, true);
		document.addEventListener("dragend", onDragEnd, true);
		return () => {
			element.removeEventListener("dragover", onDragOver, true);
			element.removeEventListener("dragleave", onDragLeave, true);
			element.removeEventListener("drop", onDrop, true);
			document.removeEventListener("dragend", onDragEnd, true);
		};
	}, [area]);

	return null;
}
