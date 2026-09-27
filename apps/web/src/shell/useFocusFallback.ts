import { type RefObject, useEffect, useRef } from "react";

/**
 * When the element behind `ref` unmounts while it holds focus (a notice that
 * goes away on its own), move focus to `fallback` so it does not drop to the
 * page (SPEC.md §25.8). Focus is recorded on the element itself, so a notice
 * that never had focus never moves it.
 */
export function useFocusFallback<T extends HTMLElement>(
	fallback: RefObject<HTMLElement | null> | undefined,
): RefObject<T | null> {
	const ref = useRef<T>(null);
	useEffect(() => {
		const container = ref.current;
		if (!container) return;
		let hadFocus = container.contains(document.activeElement);
		const onFocusIn = () => {
			hadFocus = true;
		};
		// Removal of a focused node reports no new target, so that keeps hadFocus.
		const onFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && !container.contains(next)) hadFocus = false;
		};
		container.addEventListener("focusin", onFocusIn);
		container.addEventListener("focusout", onFocusOut);
		return () => {
			container.removeEventListener("focusin", onFocusIn);
			container.removeEventListener("focusout", onFocusOut);
			const active = document.activeElement;
			const stranded =
				!active || active === document.body || container.contains(active);
			if (hadFocus && stranded) fallback?.current?.focus({ preventScroll: true });
		};
	}, [fallback]);
	return ref;
}
