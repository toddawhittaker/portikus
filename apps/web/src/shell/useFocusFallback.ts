import { type RefObject, useEffect, useRef } from "react";

/**
 * When the element behind `ref` unmounts while it holds focus (a notice that
 * goes away on its own), move focus to `fallback` so it does not drop to the
 * page (SPEC.md §25.8).
 */
export function useFocusFallback<T extends HTMLElement>(
	fallback: RefObject<HTMLElement | null> | undefined,
): RefObject<T | null> {
	const ref = useRef<T>(null);
	useEffect(() => {
		const container = ref.current;
		return () => {
			const active = document.activeElement;
			const stranded =
				!active || active === document.body || container?.contains(active) === true;
			if (stranded) fallback?.current?.focus({ preventScroll: true });
		};
	}, [fallback]);
	return ref;
}
