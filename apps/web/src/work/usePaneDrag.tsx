/**
 * Dragging a pane by its title bar onto another pane's edge, or onto the tab
 * strip to give it a tab of its own (SPEC.md §8.3, §9.3). The hook works out
 * where the drop would land; the caller's store moves the pane.
 */
import {
	type DragMoveEvent,
	type DragStartEvent,
	PointerSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { SplitNode } from "@portikus/contracts";
import { type ReactNode, type RefObject, useState } from "react";
import { type DropEdge, terminalIds } from "../layout/tree.js";
import { dropZone, insertionIndex } from "./dropZone.js";

/** The one droppable that covers the tab strip (SPEC.md §8.3). */
export const TAB_STRIP_DROP_ID = "work-tab-strip";

/** Where a dragged pane would land, as the drag moves. */
export type DragTarget =
	| { kind: "pane"; tabId: string; terminalId: string; edge: DropEdge }
	| { kind: "strip"; index: number; markerX: number };

export interface TabStripDropProps {
	/** The element `usePaneDrag` measures the tabs in. */
	strip: RefObject<HTMLDivElement | null>;
	testId: string;
	/** The drag's current target; a strip target draws the insert marker. */
	target: DragTarget | null;
	/** The tab strip itself. */
	children: ReactNode;
}

/** The tab strip as a drop area, with the marker where a dropped pane's tab would go. */
export function TabStripDrop({ strip, testId, target, children }: TabStripDropProps) {
	const drop = useDroppable({ id: TAB_STRIP_DROP_ID });
	return (
		<div className="pk-work-tabs-drop" ref={drop.setNodeRef}>
			<div className="pk-work-tabs" data-testid={testId} ref={strip}>
				{children}
				{target?.kind === "strip" ? (
					<div
						className="pk-tab-insert"
						data-testid="tab-insert-marker"
						data-index={target.index}
						style={{ left: `${target.markerX}px` }}
					/>
				) : null}
			</div>
		</div>
	);
}

export interface UsePaneDragOptions {
	tabs: readonly { id: string; root: SplitNode }[];
	/** The element holding the tab strip's `role="tab"` buttons. */
	strip: RefObject<HTMLElement | null>;
	/** Drop `dragged` beside `target` in tab `tabId`. */
	moveLeaf: (tabId: string, dragged: string, target: string, edge: DropEdge) => void;
	/** Give `dragged` a new tab at `index` in the strip. */
	moveLeafToNewTab: (dragged: string, index: number) => void;
}

/**
 * Where the pointer is now. dnd-kit reports the pointer-down event and the
 * distance dragged since, which together beat measuring the moving rect.
 */
function pointerOf(event: DragMoveEvent): { x: number; y: number } | null {
	const activator = event.activatorEvent;
	if (!(activator instanceof MouseEvent)) return null;
	return {
		x: activator.clientX + event.delta.x,
		y: activator.clientY + event.delta.y,
	};
}

export function usePaneDrag({
	tabs,
	strip,
	moveLeaf,
	moveLeafToNewTab,
}: UsePaneDragOptions) {
	const [draggedPane, setDraggedPane] = useState<{
		terminalId: string;
		title: string;
	} | null>(null);
	const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);

	// 4px so a click on a title bar still just focuses the pane, matching the
	// tab strip's own sensor.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	/** The insertion point on the tab strip, and where to draw its marker. */
	function stripTargetAt(x: number): DragTarget | null {
		const container = strip.current;
		if (!container) return null;
		const rects = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(
			(tab) => tab.getBoundingClientRect(),
		);
		const index = insertionIndex(rects, x);
		const box = container.getBoundingClientRect();
		const at = rects[index];
		const last = rects[rects.length - 1];
		const edge = at ? at.left : (last?.right ?? box.left);
		return { kind: "strip", index, markerX: edge - box.left };
	}

	function onDragStart(event: DragStartEvent) {
		setDraggedPane({
			terminalId: String(event.active.data.current?.terminalId ?? ""),
			title: String(event.active.data.current?.title ?? ""),
		});
	}

	function onDragMove(event: DragMoveEvent) {
		const dragged = String(event.active.data.current?.terminalId ?? "");
		const pointer = pointerOf(event);
		const over = event.over;
		if (!over || !pointer) {
			setDragTarget(null);
			return;
		}
		if (over.id === TAB_STRIP_DROP_ID) {
			setDragTarget(stripTargetAt(pointer.x));
			return;
		}
		const terminalId = String(over.data.current?.terminalId ?? "");
		const tab = tabs.find((item) => terminalIds(item.root).includes(terminalId));
		if (!terminalId || terminalId === dragged || !tab) {
			setDragTarget(null);
			return;
		}
		setDragTarget({
			kind: "pane",
			tabId: tab.id,
			terminalId,
			edge: dropZone(over.rect, pointer.x, pointer.y),
		});
	}

	function onDragEnd() {
		const dragged = draggedPane?.terminalId;
		const target = dragTarget;
		setDraggedPane(null);
		setDragTarget(null);
		if (!dragged || !target) return;
		if (target.kind === "strip") {
			moveLeafToNewTab(dragged, target.index);
			return;
		}
		moveLeaf(target.tabId, dragged, target.terminalId, target.edge);
	}

	function onDragCancel() {
		setDraggedPane(null);
		setDragTarget(null);
	}

	/** The pane in tab `tabId` a drag is over, and the zone it would drop into. */
	function dropTargetIn(tabId: string): { terminalId: string; edge: DropEdge } | null {
		return dragTarget?.kind === "pane" && dragTarget.tabId === tabId
			? { terminalId: dragTarget.terminalId, edge: dragTarget.edge }
			: null;
	}

	return {
		sensors,
		draggedPane,
		dragTarget,
		dropTargetIn,
		handlers: { onDragStart, onDragMove, onDragEnd, onDragCancel },
	};
}
