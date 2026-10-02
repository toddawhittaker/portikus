import * as RadixPopover from "@radix-ui/react-popover";
import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "../primitives/index.js";

export interface ToggletipProps {
	/** What the tip is about. The button is named "About {label}". */
	label: string;
	/** One to three plain sentences. No links or controls. */
	children: React.ReactNode;
}

/**
 * A help button that shows a short explanation on click, Enter or Space,
 * never on hover, so it works the same by touch, mouse and keyboard.
 * Focus stays on the button, so Tab moves on and closes the tip. The
 * visible tip is hidden from assistive technology; a live region reads
 * the text out instead, placed away from the button so it never joins
 * the name of a table header or label around it.
 */
// Spread after Radix's defaults to drop them: focus never enters the tip, so
// the button promises no popup and the hidden panel claims no dialog role.
const NOT_A_POPUP = { "aria-haspopup": undefined, "aria-controls": undefined };
const NO_ROLE = { role: undefined };

export function Toggletip({ label, children }: ToggletipProps): React.ReactElement {
	const [open, setOpen] = React.useState(false);
	const trigger = React.useRef<HTMLButtonElement>(null);
	const [liveHost, setLiveHost] = React.useState<Element | null>(null);
	React.useLayoutEffect(() => {
		// Inside a modal dialog, anything outside it is hidden from screen readers.
		setLiveHost(
			trigger.current?.closest("[role='dialog'], [role='alertdialog']") ??
				document.body,
		);
	}, []);
	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger
				ref={trigger}
				className="pk-toggletip pk-focus-ring"
				aria-label={`About ${label}`}
				{...NOT_A_POPUP}
			>
				<Icon name="help" size="sm" />
			</RadixPopover.Trigger>
			{liveHost
				? createPortal(
						// Present before it fills, so screen readers announce the change.
						<span aria-live="polite" className="sr-only">
							{open ? children : null}
						</span>,
						liveHost,
					)
				: null}
			<RadixPopover.Portal>
				<RadixPopover.Content
					className="pk-toggletip-content"
					{...NO_ROLE}
					aria-hidden="true"
					side="top"
					align="start"
					sideOffset={4}
					collisionPadding={8}
					onOpenAutoFocus={(event) => event.preventDefault()}
					// Focus never left the button; Radix's deferred return would steal it back from the next control.
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					{children}
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
