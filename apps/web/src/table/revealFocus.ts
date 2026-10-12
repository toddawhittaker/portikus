import type { FocusEvent } from "react";

/**
 * Brings a focused control fully into view. Chrome leaves a control that is
 * half past the edge of a table box scrolling sideways (a narrow admin
 * window, SPEC.md section 20.1) where it is, so only part of it shows.
 */
export function revealFocused(event: FocusEvent<HTMLElement>): void {
	event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
