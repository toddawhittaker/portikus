/**
 * Dragging a pane, a terminal or a file, by its title bar onto another pane's
 * edge, or onto the tab strip to give it a tab of its own (SPEC.md §8.3,
 * §9.3). Holding a drag over a tab in the strip opens that tab, so a pane can
 * be dropped into a tab that was not on screen. The hook works out where the
 * drop would land; the caller's store moves the pane.
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
import { tabDomId } from "@portikus/ui";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { type DropEdge, paneIds } from "../layout/tree.js";
import { dropZone, insertionIndex, tabUnder } from "./dropZone.js";

/** The one droppable that covers the tab strip (SPEC.md §8.3). */
export const TAB_STRIP_DROP_ID = "work-tab-strip";

/** How long a drag rests on a tab before that tab opens, as file managers do. */
export const SPRING_OPEN_MS = 600;

/**
 * Where a dragged pane would land, as the drag moves. `paneId` is a
 * terminal id, or `file:<path>` for a file.
 */
export type DragTarget =
	| { kind: "pane"; tabId: string; paneId: string; edge: DropEdge }
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
	/** Show a tab a drag has rested on; without it the strip only takes new tabs. */
	activateTab?: (tabId: string) => void;
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
	activateTab,
}: UsePaneDragOptions) {
	const [draggedPane, setDraggedPane] = useState<{
		paneId: string;
		title: string;
	} | null>(null);
	const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
	// The tab the drag is resting on, and the timer that will open it.
	const spring = useRef<{ tabId: string; timer: ReturnType<typeof setTimeout> } | null>(
		null,
	);

	function restOn(tabId: string | null) {
		if (spring.current?.tabId === tabId) return;
		if (spring.current) clearTimeout(spring.current.timer);
		spring.current = null;
		if (tabId === null || !activateTab) return;
		const timer = setTimeout(() => {
			spring.current = null;
			activateTab(tabId);
		}, SPRING_OPEN_MS);
		spring.current = { tabId, timer };
	}

	useEffect(
		() => () => {
			if (spring.current) clearTimeout(spring.current.timer);
		},
		[],
	);

	/** The tab in the strip under the pointer, by its id, or null. */
	function tabAt(x: number, y: number): string | null {
		const container = strip.current;
		if (!container) return null;
		const elements = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
		const index = tabUnder(
			elements.map((element) => element.getBoundingClientRect()),
			x,
			y,
		);
		const domId = elements[index]?.id;
		return tabs.find((tab) => tabDomId(tab.id) === domId)?.id ?? null;
	}

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
			paneId: String(event.active.data.current?.paneId ?? ""),
			title: String(event.active.data.current?.title ?? ""),
		});
	}

	function onDragMove(event: DragMoveEvent) {
		const dragged = String(event.active.data.current?.paneId ?? "");
		const pointer = pointerOf(event);
		const over = event.over;
		if (!over || !pointer) {
			restOn(null);
			setDragTarget(null);
			return;
		}
		if (over.id === TAB_STRIP_DROP_ID) {
			restOn(tabAt(pointer.x, pointer.y));
			setDragTarget(stripTargetAt(pointer.x));
			return;
		}
		restOn(null);
		const paneId = String(over.data.current?.paneId ?? "");
		const tab = tabs.find((item) => paneIds(item.root).includes(paneId));
		if (!paneId || paneId === dragged || !tab) {
			setDragTarget(null);
			return;
		}
		setDragTarget({
			kind: "pane",
			tabId: tab.id,
			paneId,
			edge: dropZone(over.rect, pointer.x, pointer.y),
		});
	}

	function onDragEnd() {
		restOn(null);
		const dragged = draggedPane?.paneId;
		const target = dragTarget;
		setDraggedPane(null);
		setDragTarget(null);
		if (!dragged || !target) return;
		if (target.kind === "strip") {
			moveLeafToNewTab(dragged, target.index);
			return;
		}
		moveLeaf(target.tabId, dragged, target.paneId, target.edge);
	}

	function onDragCancel() {
		restOn(null);
		setDraggedPane(null);
		setDragTarget(null);
	}

	/** The pane in tab `tabId` a drag is over, and the zone it would drop into. */
	function dropTargetIn(tabId: string): { paneId: string; edge: DropEdge } | null {
		return dragTarget?.kind === "pane" && dragTarget.tabId === tabId
			? { paneId: dragTarget.paneId, edge: dragTarget.edge }
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
