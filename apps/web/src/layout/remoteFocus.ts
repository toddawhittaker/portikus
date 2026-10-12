import { type RefObject, useEffect, useState } from "react";
import { type LayoutStore, useLayout } from "./store.js";

export const REMOTE_FOCUS_LOST = "The layout changed in another browser.";

/**
 * When a layout saved in another browser removes or hides the pane that held
 * focus here, focus goes to the work area's main landmark rather than the
 * page, and the returned text says why for a polite region (SPEC.md §7.5,
 * §25.8). Empty until that happens.
 */
export function useRemoteFocusFallback(
	store: LayoutStore,
	area: RefObject<HTMLElement | null>,
): string {
	const lost = useLayout(store, (state) => state.remoteFocusLost);
	const [said, setSaid] = useState("");
	useEffect(() => {
		if (lost === 0 || !focusFellAway(area.current)) return;
		area.current?.closest("main")?.focus();
		setSaid(REMOTE_FOCUS_LOST);
	}, [lost, area]);
	return said;
}

/** Focus fell to the page, or stays on something in the area no one can see. */
function focusFellAway(area: HTMLElement | null): boolean {
	const active = document.activeElement;
	if (active === null || active === document.body) return true;
	if (!(active instanceof HTMLElement) || !area?.contains(active)) return false;
	return typeof active.checkVisibility === "function" && !active.checkVisibility();
}
