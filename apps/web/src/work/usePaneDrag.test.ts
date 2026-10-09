import type { DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import type { SplitNode } from "@portikus/contracts";
import { tabDomId } from "@portikus/ui";
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SPRING_OPEN_MS, TAB_STRIP_DROP_ID, usePaneDrag } from "./usePaneDrag";

const tabs: { id: string; root: SplitNode }[] = [
	{ id: "tab-a", root: { type: "leaf", terminalId: "t1" } },
	{ id: "file:src/app.ts", root: { type: "file", path: "src/app.ts" } },
	{
		id: "tab-b",
		root: {
			type: "split",
			direction: "row",
			sizes: [50, 50],
			children: [
				{ type: "leaf", terminalId: "t2" },
				{ type: "leaf", terminalId: "t3" },
			],
		},
	},
];

const paneRect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };

function start(terminalId: string): DragStartEvent {
	return {
		active: {
			id: `pane-drag-${terminalId}`,
			data: { current: { terminalId, title: "zsh" } },
		},
	} as unknown as DragStartEvent;
}

/** A drag of `dragged` with the pointer at (x, y), over `over`. */
function move(
	dragged: string,
	x: number,
	y: number,
	over: { id: string; terminalId?: string } | null,
): DragMoveEvent {
	return {
		active: { data: { current: { terminalId: dragged } } },
		activatorEvent: new MouseEvent("pointerdown", { clientX: 0, clientY: 0 }),
		delta: { x, y },
		over: over
			? {
					id: over.id,
					rect: paneRect,
					data: { current: { terminalId: over.terminalId } },
				}
			: null,
	} as unknown as DragMoveEvent;
}

function setup(strip: HTMLElement | null = null) {
	const moveLeaf = vi.fn();
	const moveLeafToNewTab = vi.fn();
	const view = renderHook(() =>
		usePaneDrag({ tabs, strip: { current: strip }, moveLeaf, moveLeafToNewTab }),
	);
	return { view, moveLeaf, moveLeafToNewTab };
}

test("dropping on another pane's edge moves the pane beside it in that tab", () => {
	const { view, moveLeaf } = setup();
	act(() => view.result.current.handlers.onDragStart(start("t1")));
	expect(view.result.current.draggedPane).toEqual({ terminalId: "t1", title: "zsh" });
	act(() =>
		view.result.current.handlers.onDragMove(
			move("t1", 95, 50, { id: "pane-drop-t3", terminalId: "t3" }),
		),
	);
	expect(view.result.current.dropTargetIn("tab-b")).toEqual({
		terminalId: "t3",
		edge: "right",
	});
	expect(view.result.current.dropTargetIn("tab-a")).toBeNull();
	act(() => view.result.current.handlers.onDragEnd());
	expect(moveLeaf).toHaveBeenCalledWith("tab-b", "t1", "t3", "right");
	expect(view.result.current.draggedPane).toBeNull();
	expect(view.result.current.dragTarget).toBeNull();
});

test("a pane over itself, or over nothing, has nowhere to land", () => {
	const { view, moveLeaf } = setup();
	act(() => view.result.current.handlers.onDragStart(start("t2")));
	act(() =>
		view.result.current.handlers.onDragMove(
			move("t2", 50, 50, { id: "pane-drop-t2", terminalId: "t2" }),
		),
	);
	expect(view.result.current.dragTarget).toBeNull();
	act(() => view.result.current.handlers.onDragMove(move("t2", 50, 50, null)));
	expect(view.result.current.dragTarget).toBeNull();
	act(() => view.result.current.handlers.onDragEnd());
	expect(moveLeaf).not.toHaveBeenCalled();
});

test("dropping on the tab strip gives the pane a new tab at the insertion point", () => {
	const strip = document.createElement("div");
	for (const left of [0, 100]) {
		const tab = document.createElement("button");
		tab.setAttribute("role", "tab");
		tab.getBoundingClientRect = () =>
			({
				left,
				right: left + 100,
				top: 0,
				bottom: 30,
				width: 100,
				height: 30,
			}) as DOMRect;
		strip.append(tab);
	}
	strip.getBoundingClientRect = () =>
		({ left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30 }) as DOMRect;
	const { view, moveLeafToNewTab } = setup(strip);
	act(() => view.result.current.handlers.onDragStart(start("t2")));
	act(() =>
		view.result.current.handlers.onDragMove(
			move("t2", 250, 10, { id: TAB_STRIP_DROP_ID }),
		),
	);
	expect(view.result.current.dragTarget).toEqual({
		kind: "strip",
		index: 2,
		markerX: 200,
	});
	act(() => view.result.current.handlers.onDragEnd());
	expect(moveLeafToNewTab).toHaveBeenCalledWith("t2", 2);
});

test("a cancelled drag moves nothing", () => {
	const { view, moveLeaf } = setup();
	act(() => view.result.current.handlers.onDragStart(start("t1")));
	act(() =>
		view.result.current.handlers.onDragMove(
			move("t1", 95, 50, { id: "pane-drop-t3", terminalId: "t3" }),
		),
	);
	act(() => view.result.current.handlers.onDragCancel());
	expect(view.result.current.draggedPane).toBeNull();
	act(() => view.result.current.handlers.onDragEnd());
	expect(moveLeaf).not.toHaveBeenCalled();
});

/** A strip of one tab button per id, each 100 pixels wide, in order. */
function stripOf(ids: string[]): HTMLElement {
	const strip = document.createElement("div");
	ids.forEach((id, index) => {
		const tab = document.createElement("button");
		tab.setAttribute("role", "tab");
		tab.id = tabDomId(id);
		const left = index * 100;
		tab.getBoundingClientRect = () =>
			({
				left,
				right: left + 100,
				top: 0,
				bottom: 30,
				width: 100,
				height: 30,
			}) as DOMRect;
		strip.append(tab);
	});
	strip.getBoundingClientRect = () =>
		({ left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30 }) as DOMRect;
	return strip;
}

test("a file pane can be dropped beside a terminal like any pane", () => {
	const { view, moveLeaf } = setup();
	act(() => view.result.current.handlers.onDragStart(start("file:src/app.ts")));
	act(() =>
		view.result.current.handlers.onDragMove(
			move("file:src/app.ts", 95, 50, { id: "pane-drop-t1", terminalId: "t1" }),
		),
	);
	act(() => view.result.current.handlers.onDragEnd());
	expect(moveLeaf).toHaveBeenCalledWith("tab-a", "file:src/app.ts", "t1", "right");
});

test("a drag resting on a tab opens it, and one that moves on does not", () => {
	vi.useFakeTimers();
	try {
		const activateTab = vi.fn();
		const strip = stripOf(["tab-a", "file:src/app.ts", "tab-b"]);
		const view = renderHook(() =>
			usePaneDrag({
				tabs,
				strip: { current: strip },
				moveLeaf: vi.fn(),
				moveLeafToNewTab: vi.fn(),
				activateTab,
			}),
		);
		const drag = view.result.current.handlers;
		act(() => drag.onDragStart(start("file:src/app.ts")));
		// Passing over the first tab on the way to the third opens neither early.
		act(() =>
			drag.onDragMove(move("file:src/app.ts", 50, 10, { id: TAB_STRIP_DROP_ID })),
		);
		act(() => vi.advanceTimersByTime(SPRING_OPEN_MS - 100));
		act(() =>
			drag.onDragMove(move("file:src/app.ts", 250, 10, { id: TAB_STRIP_DROP_ID })),
		);
		act(() => vi.advanceTimersByTime(SPRING_OPEN_MS - 100));
		expect(activateTab).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(100));
		expect(activateTab).toHaveBeenCalledExactlyOnceWith("tab-b");
		// Ending the drag while resting on a tab cancels the pending open.
		act(() =>
			drag.onDragMove(move("file:src/app.ts", 50, 10, { id: TAB_STRIP_DROP_ID })),
		);
		act(() => view.result.current.handlers.onDragCancel());
		act(() => vi.advanceTimersByTime(SPRING_OPEN_MS));
		expect(activateTab).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});
