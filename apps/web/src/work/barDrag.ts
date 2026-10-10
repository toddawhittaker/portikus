/**
 * A file pane's whole title bar as its drag handle (SPEC.md §9.3): the same
 * dnd-kit listeners a terminal's bar uses, with presses on the bar's own
 * controls left to them.
 */
import type { DraggableSyntheticListeners } from "@dnd-kit/core";

/** What a press in the title bar must leave to the control it lands on. */
const BAR_CONTROL =
	'button, a[href], input, select, textarea, label, [role="button"], [contenteditable]';

/**
 * The drag listeners for the whole bar, minus presses on its buttons and
 * fields, so those still click and a held voice button never drags. A menu
 * the bar opens is portalled out of it, yet React still bubbles its events
 * here, so a press outside the bar's own DOM is left alone too.
 */
export function fromEmptySpace(
	listeners: DraggableSyntheticListeners,
): DraggableSyntheticListeners {
	if (!listeners) return listeners;
	return Object.fromEntries(
		Object.entries(listeners).map(([name, listener]) => [
			name,
			(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
				const { target, currentTarget } = event;
				if (!(target instanceof Element) || !(currentTarget instanceof Element)) return;
				if (!currentTarget.contains(target) || target.closest(BAR_CONTROL)) return;
				listener(event);
			},
		]),
	);
}
