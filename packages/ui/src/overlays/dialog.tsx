import * as RadixDialog from "@radix-ui/react-dialog";
import * as React from "react";
import { IconButton } from "../primitives/index.js";

export const DialogRoot = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;

export interface DialogProps {
	id?: string;
	title: React.ReactNode;
	description?: React.ReactNode;
	children?: React.ReactNode;
	footer?: React.ReactNode;
	size?: "md" | "lg";
	/** Extra classes on the dialog frame. */
	className?: string;
	onClose?: () => void;
	role?: "dialog" | "alertdialog";
	/** Test hook: set as `data-testid` on the dialog surface. */
	testId?: string;
}

interface FocusOrigin {
	element: HTMLElement;
	/** The button that opened the menu, when the element is a menu item. */
	menuTrigger: HTMLElement | null;
	/** What had focus before the menu opened, for a menu with no trigger. */
	beforeMenu: HTMLElement | null;
}

function focusOrigin(element: HTMLElement): FocusOrigin {
	const menu = element.closest('[role="menu"]');
	const menuId = menu?.getAttribute("aria-labelledby");
	return {
		element,
		menuTrigger: menuId ? document.getElementById(menuId) : null,
		beforeMenu: menu ? lastOutsideMenu : null,
	};
}

// A menu item that opens a dialog unmounts before the dialog mounts, and focus
// falls to the body, so remember the last focused element as it happens.
let lastFocus: FocusOrigin | null = null;
// A right-click menu has no trigger button, so keep what had focus before it.
let lastOutsideMenu: HTMLElement | null = null;
let tracking = false;

function trackFocus(event: FocusEvent): void {
	if (!(event.target instanceof HTMLElement)) return;
	lastFocus = focusOrigin(event.target);
	if (!event.target.closest('[role="menu"]')) lastOutsideMenu = event.target;
}

/**
 * Puts focus back where it was when a dialog opened. Most dialogs open from
 * state or a menu item, so Radix has no trigger to return to and focus would
 * fall to the page body (issue #358).
 */
export function useReturnFocus(): {
	onOpenAutoFocus: () => void;
	onCloseAutoFocus: (event: Event) => void;
} {
	const origin = React.useRef<FocusOrigin | null>(null);
	React.useEffect(() => {
		if (tracking) return;
		tracking = true;
		document.addEventListener("focusin", trackFocus);
	}, []);
	return {
		onOpenAutoFocus() {
			const active = document.activeElement;
			origin.current =
				active instanceof HTMLElement && active !== document.body
					? focusOrigin(active)
					: lastFocus;
		},
		onCloseAutoFocus(event) {
			const target = [
				origin.current?.element,
				origin.current?.menuTrigger,
				origin.current?.beforeMenu,
			].find(
				(element) =>
					element?.isConnected &&
					element !== document.body &&
					// A menu or pane that hid rather than unmounted cannot take focus.
					element.checkVisibility?.() !== false,
			);
			origin.current = null;
			if (!target) return;
			event.preventDefault();
			target.focus({ preventScroll: true });
		},
	};
}

/**
 * The styled modal. Render it inside a DialogRoot; Radix owns the focus trap,
 * Escape and the return of focus to the trigger; useReturnFocus covers
 * dialogs opened without one.
 */
export function Dialog({
	id,
	title,
	description,
	children,
	footer,
	size,
	className,
	onClose,
	role,
	testId,
}: DialogProps): React.ReactElement {
	const returnFocus = useReturnFocus();
	return (
		<RadixDialog.Portal>
			<RadixDialog.Overlay className="pk-scrim" />
			<RadixDialog.Content
				id={id}
				data-testid={testId}
				// Spread so we never override Radix's own role with undefined.
				{...(role ? { role } : {})}
				// Focus the dialog itself, not the close button: its tooltip would open
				// on that focus and swallow the first Escape.
				onOpenAutoFocus={(event) => {
					returnFocus.onOpenAutoFocus();
					event.preventDefault();
					(event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
				}}
				onCloseAutoFocus={returnFocus.onCloseAutoFocus}
				className={["pk-dialog", size === "lg" ? "pk-dialog--lg" : "", className]
					.filter(Boolean)
					.join(" ")}
			>
				<div className="pk-dialog-head flex items-start gap-3 px-6 pt-6">
					<div className="min-w-0">
						<RadixDialog.Title className="m-0 text-xl font-semibold text-ink">
							{title}
						</RadixDialog.Title>
						{description ? (
							<RadixDialog.Description className="mt-1 mb-0 text-ink-muted">
								{description}
							</RadixDialog.Description>
						) : (
							// Radix warns without a description; an empty one keeps the console quiet.
							<RadixDialog.Description className="hidden" />
						)}
					</div>
					<RadixDialog.Close asChild>
						<IconButton
							icon="x"
							label="Close"
							size="sm"
							className="ml-auto"
							onClick={onClose}
						/>
					</RadixDialog.Close>
				</div>
				{/* Without a footer the body carries the bottom padding itself. */}
				{children ? (
					<div className={`pk-dialog-body px-6 pt-4 ${footer ? "" : "pb-6"}`}>
						{children}
					</div>
				) : null}
				{footer ? (
					<div className="pk-dialog-foot flex justify-end gap-2 p-6">{footer}</div>
				) : null}
			</RadixDialog.Content>
		</RadixDialog.Portal>
	);
}
