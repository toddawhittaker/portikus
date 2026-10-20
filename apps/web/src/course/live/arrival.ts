import { type RefObject, useEffect } from "react";

/**
 * Set by a page that moves away from under the keyboard, as Leave session
 * does: the button the focus was on is gone, so the next page's heading
 * takes it. One page at a time, so a module flag is enough.
 */
let focusNextHeading = false;

/** Ask the next page that calls `useFocusHeadingOnArrival` to focus its heading. */
export function focusHeadingOnArrival(): void {
	focusNextHeading = true;
}

/** Focus `heading` once on mount if the page before asked for it. */
export function useFocusHeadingOnArrival(heading: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		if (!focusNextHeading) return;
		focusNextHeading = false;
		heading.current?.focus();
	}, [heading]);
}
