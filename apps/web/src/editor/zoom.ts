/**
 * Pane zoom (SPEC.md §13.1): the editor, terminal and chat panes each zoom
 * on their own. The zoom is a percentage of the pane's base font size, held
 * for this session only, and the browser's own zoom is left alone. The value
 * for each file and each pane lives in the layout store (layout/store.ts);
 * this module holds the arithmetic and the wheel handling they share.
 */
import { createContext } from "react";

/** The font size at 100%, matching baseEditorOptions in monaco.ts. */
export const BASE_FONT_SIZE = 14;

export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 300;
/** One keypress or one wheel notch. */
const ZOOM_STEP = 10;
/**
 * The pixels one wheel notch scrolls, roughly. Smaller pixel deltas, which a
 * trackpad pinch sends many of, add up to a step rather than each being one.
 */
const WHEEL_NOTCH = 50;

export function clampZoom(percent: number): number {
	if (!Number.isFinite(percent)) return DEFAULT_ZOOM;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent)));
}

/** Step the zoom by whole steps: +1 is one step in, -1 one step out. */
export function stepZoom(percent: number, steps: number): number {
	return clampZoom(percent + steps * ZOOM_STEP);
}

/** The font size for a zoom percentage, never below one pixel. */
export function fontSizeFor(percent: number): number {
	return Math.max(1, Math.round((BASE_FONT_SIZE * clampZoom(percent)) / 100));
}

/**
 * A wheel listener that turns Ctrl (Cmd on a Mac) with the wheel into zoom
 * steps for one pane, and takes the event so the browser never zooms the
 * page. A trackpad pinch arrives as Ctrl with the wheel, so it zooms the pane
 * under the pointer too (SPEC.md §20.1). Attach it with `passive: false`.
 */
export function wheelZoom(step: (steps: number) => void): (event: WheelEvent) => void {
	let pending = 0;
	return (event) => {
		if (!(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.deltaY === 0) return;
		const notch =
			event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
			Math.abs(event.deltaY) >= WHEEL_NOTCH;
		pending = notch ? event.deltaY : pending + event.deltaY;
		if (Math.abs(pending) < WHEEL_NOTCH && !notch) return;
		step(pending < 0 ? 1 : -1);
		pending = 0;
	};
}

/**
 * The editor's zoom keys, which the chat pane takes too: Ctrl (Cmd) with
 * Shift and = or -, and Ctrl (Cmd) with 0 for 100%. Null for any other key.
 * A terminal leaves these to the shell.
 */
export function zoomKey(
	event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
): "in" | "out" | "reset" | null {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
	if (event.shiftKey && event.code === "Equal") return "in";
	if (event.shiftKey && event.code === "Minus") return "out";
	if (!event.shiftKey && event.code === "Digit0") return "reset";
	return null;
}

/** The zoom of the terminal or chat pane around a component. */
export const PaneZoomContext = createContext(DEFAULT_ZOOM);
