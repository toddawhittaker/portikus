import { useCallback, useSyncExternalStore } from "react";

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (typeof window.matchMedia !== "function") return () => {};
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
	);
}
