import { IconButton } from "@portikus/ui";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";

/** Below this width the side panes become drawers over the work area (SPEC.md §8.1). */
export const PHONE_QUERY = "(width < 56rem)";

function subscribe(onChange: () => void): () => void {
	const query = window.matchMedia(PHONE_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True while the window is narrower than 56rem. */
export function usePhoneLayout(): boolean {
	return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches);
}

/**
 * Marks everything outside `layer`, up to the children of `.pk-root`, inert,
 * so focus and the screen reader stay in the drawer. Toasts and dialogs
 * portalled outside the shell stay reachable. Returns the undo.
 */
export function inertOutside(layer: HTMLElement): () => void {
	const marked: HTMLElement[] = [];
	let node: HTMLElement = layer;
	while (node.parentElement) {
		const parent: HTMLElement = node.parentElement;
		for (const sibling of Array.from(parent.children)) {
			if (
				sibling === node ||
				!(sibling instanceof HTMLElement) ||
				sibling.hasAttribute("inert")
			)
				continue;
			sibling.setAttribute("inert", "");
			marked.push(sibling);
		}
		if (parent.classList.contains("pk-root")) break;
		node = parent;
	}
	return () => {
		for (const element of marked) element.removeAttribute("inert");
	};
}

const TABBABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Tab from the last stop goes to the first, and Shift+Tab from the first to
 * the last, so focus cannot leave an open drawer for the browser's own bar.
 */
export function wrapTab(
	sheet: HTMLElement,
	event: { shiftKey: boolean; preventDefault: () => void },
): void {
	const stops = Array.from(sheet.querySelectorAll<HTMLElement>(TABBABLE)).filter(
		(element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
	);
	const first = stops[0];
	const last = stops.at(-1);
	if (!first || !last) return;
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === sheet)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * A side pane's content. At phone widths it is a modal drawer: named, focus
 * kept inside, closed by Escape, a tap outside, its close button or a link
 * chosen in it, and focus goes back to `opener` (SPEC.md §8.1, §25.8). At
 * wider widths it adds no box and no role.
 */
export function ShellDrawer({
	id,
	side,
	label,
	phone,
	open,
	onClose,
	opener,
	children,
}: {
	id: string;
	side: "left" | "right";
	label: string;
	phone: boolean;
	open: boolean;
	onClose: () => void;
	opener: RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const layer = useRef<HTMLDivElement>(null);
	const sheet = useRef<HTMLDivElement>(null);
	const modal = phone && open;

	useEffect(() => {
		if (!modal || !layer.current) return;
		const restore = inertOutside(layer.current);
		// The sheet, not its close button, so the button's tooltip does not take the first Escape.
		sheet.current?.focus();
		return () => {
			restore();
			opener.current?.focus();
		};
	}, [modal, opener]);

	return (
		<div
			className={`pk-drawer-layer pk-drawer-layer--${side}`}
			data-open={modal ? "true" : undefined}
			ref={layer}
		>
			{/* Pointer only: Escape and the close button are the keyboard's ways out. */}
			{phone ? (
				<div className="pk-drawer-scrim" aria-hidden="true" onClick={onClose} />
			) : null}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the handlers catch Escape and link clicks from the controls inside */}
			<div
				id={id}
				className="pk-drawer"
				ref={sheet}
				// The pane inside keeps its own landmark; only a phone's drawer is a dialog.
				{...(phone
					? { role: "dialog", "aria-modal": true, "aria-label": label, tabIndex: -1 }
					: {})}
				onKeyDown={(event) => {
					if (modal && event.key === "Tab" && sheet.current) {
						wrapTab(sheet.current, event);
						return;
					}
					if (!modal || event.key !== "Escape" || event.defaultPrevented) return;
					// A menu portalled out of the drawer handles its own Escape.
					if (!(event.target instanceof Node) || !sheet.current?.contains(event.target))
						return;
					event.preventDefault();
					onClose();
				}}
				onClick={(event) => {
					if (!modal || !(event.target instanceof Element)) return;
					const link = event.target.closest("a[href]");
					if (link && !link.getAttribute("target")) onClose();
				}}
			>
				{phone ? (
					<div className="pk-drawer-bar">
						<IconButton
							icon="x"
							label={`Close ${label.toLowerCase()}`}
							onClick={onClose}
						/>
					</div>
				) : null}
				{children}
			</div>
		</div>
	);
}
