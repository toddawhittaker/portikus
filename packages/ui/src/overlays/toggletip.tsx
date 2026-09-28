import * as RadixPopover from "@radix-ui/react-popover";
import * as React from "react";
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
 * Focus stays on the button, so Tab moves on and closes the tip; a live
 * region beside the button reads the text out when it opens.
 */
export function Toggletip({ label, children }: ToggletipProps): React.ReactElement {
	const [open, setOpen] = React.useState(false);
	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger
				className="pk-toggletip pk-focus-ring"
				aria-label={`About ${label}`}
			>
				<Icon name="help" size="sm" />
			</RadixPopover.Trigger>
			{/* Present before it fills, so screen readers announce the change. */}
			<span aria-live="polite" className="sr-only">
				{open ? children : null}
			</span>
			<RadixPopover.Portal>
				<RadixPopover.Content
					className="pk-toggletip-content"
					aria-label={label}
					side="top"
					align="start"
					sideOffset={4}
					collisionPadding={8}
					onOpenAutoFocus={(event) => event.preventDefault()}
				>
					<span aria-hidden="true">{children}</span>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
