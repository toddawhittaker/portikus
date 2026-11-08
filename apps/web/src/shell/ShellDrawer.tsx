import { hideOutside, IconButton } from "@portikus/ui";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import "./drawer.css";

/**
 * Below this width the side panes become drawers over the work area (SPEC.md §8.1).
 * app.css and drawer.css repeat 56rem, since a media query cannot read a variable.
 */
const PHONE_QUERY = "(width < 56rem)";

function subscribe(onChange: () => void): () => void {
	const query = window.matchMedia(PHONE_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True while the window is narrower than 56rem. */
export function usePhoneLayout(): boolean {
	return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches);
}

const TABBABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], summary, iframe, audio[controls], video[controls]';

/**
 * Tab from the last stop goes to the first, and Shift+Tab from the first to
 * the last, so focus cannot leave an open drawer for the page behind it.
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
 * Back to the opener, or, when a wider window has hidden it, into the pane
 * the drawer held: its selected tab, else its first stop.
 */
export function restoreFocus(opener: HTMLElement | null, sheet: HTMLElement): void {
	if (opener && opener.getClientRects().length > 0) {
		opener.focus();
		return;
	}
	const target =
		sheet.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
		sheet.querySelector<HTMLElement>(TABBABLE);
	target?.focus();
}

/**
 * A side pane's content. At phone widths it is a modal drawer: named, focus
 * kept inside, closed by Escape, a tap outside, its close button or a link
 * chosen in it, and focus goes back to `opener` (SPEC.md §8.1, §25.8). At
 * wider widths it adds no box and no role. Not a Radix Dialog, which portals
 * and has a dialog role: the same pane must stay mounted, as a plain pane, at
 * desktop width. The page behind is hidden with aria-hidden, not inert, so its
 * live regions are still heard (ADR 0047).
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
	const close = useRef(onClose);
	close.current = onClose;
	const modal = phone && open;

	useEffect(() => {
		const shown = layer.current;
		const current = sheet.current;
		if (!modal || !shown || !current) return;
		const root = shown.closest(".pk-root");
		const restore = hideOutside(current);
		let returnFocus = true;
		// Code that moves focus to the page behind means to show it, so the drawer gets out of the way.
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target;
			if (
				!(target instanceof Node) ||
				shown.contains(target) ||
				!root?.contains(target)
			)
				return;
			returnFocus = false;
			close.current();
		};
		document.addEventListener("focusin", onFocusIn);
		// The sheet, not its close button, so the button's tooltip does not take the first Escape.
		current.focus();
		return () => {
			document.removeEventListener("focusin", onFocusIn);
			restore();
			if (returnFocus) restoreFocus(opener.current, current);
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
					// A menu portalled out of the drawer handles its own keys.
					if (
						!modal ||
						!sheet.current ||
						!(event.target instanceof Node) ||
						!sheet.current.contains(event.target)
					)
						return;
					if (event.key === "Tab") wrapTab(sheet.current, event);
					else if (event.key === "Escape" && !event.defaultPrevented) {
						event.preventDefault();
						onClose();
					}
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
