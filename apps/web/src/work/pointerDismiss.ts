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

/**
 * Focus handling for a pane's actions menu. Radix focuses the trigger when
 * the menu closes, and that programmatic focus paints the focus ring, so a
 * pointer dismiss leaves the trigger at rest; a keyboard dismiss still
 * focuses it. `thenFocus` runs an action once the menu has closed instead,
 * for an action that moves the keyboard elsewhere or removes the pane.
 */
export function usePaneMenuFocus() {
	const { pointer, track: onOpenChange } = usePointerDismiss();
	const afterClose = useRef<(() => void) | null>(null);

	function thenFocus(action: () => void) {
		afterClose.current = action;
	}

	function onCloseAutoFocus(event: Event) {
		const action = afterClose.current;
		if (action) {
			afterClose.current = null;
			event.preventDefault();
			action();
			return;
		}
		if (!pointer.current) return;
		event.preventDefault();
		pointer.current = false;
	}

	return { onOpenChange, onCloseAutoFocus, thenFocus };
}
