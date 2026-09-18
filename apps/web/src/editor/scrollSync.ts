/**
 * Keeping the two sides of the Markdown split view at the same place
 * (SPEC.md §13.4). Both sides are matched by relative position: how far down
 * its own scrollable range each one is. That is a plain ratio, not a mapping
 * from source lines to rendered blocks, so a long code block can drift a
 * little from the heading it belongs to.
 */

/** How far down its range a scroller is, from 0 at the top to 1 at the end. */
export function scrollRatio(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
): number {
	const range = scrollHeight - clientHeight;
	if (!(range > 0)) return 0;
	return clamp(scrollTop / range);
}

/** The scroll offset that puts a scroller at the given relative position. */
export function scrollTopForRatio(
	ratio: number,
	scrollHeight: number,
	clientHeight: number,
): number {
	const range = scrollHeight - clientHeight;
	if (!(range > 0)) return 0;
	return clamp(ratio) * range;
}

function clamp(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}
