import { type RefObject, useEffect, useRef } from "react";

/**
 * Whether an open menu was last dismissed by pointer rather than keyboard.
 * Call `track` from the menu's onOpenChange; `pointer` is true when the
 * dismissing input was a pointer, so the caller can skip refocusing the
 * trigger and its focus ring.
 */
export function usePointerDismiss(): {
	pointer: RefObject<boolean>;
	track: (open: boolean) => void;
} {
	const pointer = useRef(false);
	const stop = useRef<(() => void) | null>(null);

	useEffect(() => () => stop.current?.(), []);

	function track(open: boolean) {
		stop.current?.();
		stop.current = null;
		if (!open) return;
		pointer.current = false;
		const onPointerDown = () => {
			pointer.current = true;
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
				pointer.current = false;
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		stop.current = () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}

	return { pointer, track };
}
