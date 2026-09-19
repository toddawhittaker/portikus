/**
 * Editor-only zoom (SPEC.md §13.1). The zoom is a percentage of the base font
 * size, held per open file for this session only; nothing is persisted and
 * the browser's own zoom is left alone. The value for each file lives in the
 * layout store, beside the cursor and scroll position (layout/store.ts,
 * issue #162); this module only holds the arithmetic.
 */

/** The font size at 100%, matching baseEditorOptions in monaco.ts. */
export const BASE_FONT_SIZE = 13;

export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 300;
/** One keypress or one wheel notch. */
export const ZOOM_STEP = 10;

export function clampZoom(percent: number): number {
	if (!Number.isFinite(percent)) return DEFAULT_ZOOM;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent)));
}

/** Step the zoom by whole steps: +1 is one step in, -1 one step out. */
export function stepZoom(percent: number, steps: number): number {
	return clampZoom(percent + steps * ZOOM_STEP);
}

/** The Monaco font size for a zoom percentage, never below one pixel. */
export function fontSizeFor(percent: number): number {
	return Math.max(1, Math.round((BASE_FONT_SIZE * clampZoom(percent)) / 100));
}
