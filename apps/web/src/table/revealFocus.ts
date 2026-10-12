import type { FocusEvent } from "react";

/**
 * Brings a control the keyboard focused fully into view. Chrome leaves a
 * control that is half past the edge of a table box scrolling sideways (a
 * narrow admin window, SPEC.md section 20.1) where it is, so only part of it
 * shows. A click already shows what it hit, and a focus from a portal (a menu
 * or dialog opened from a row) bubbles here through React but is not inside
 * the box, so neither scrolls it.
 */
export function revealFocused(event: FocusEvent<HTMLElement>): void {
	const target = event.target;
	if (target === event.currentTarget || !event.currentTarget.contains(target)) return;
	if (!target.matches(":focus-visible")) return;
	target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
