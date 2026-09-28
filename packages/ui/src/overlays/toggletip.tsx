import * as RadixPopover from "@radix-ui/react-popover";
import type * as React from "react";
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
 */
export function Toggletip({ label, children }: ToggletipProps): React.ReactElement {
	return (
		<RadixPopover.Root>
			<RadixPopover.Trigger
				className="pk-toggletip pk-focus-ring"
				aria-label={`About ${label}`}
			>
				<Icon name="help" size="sm" />
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					className="pk-toggletip-content"
					aria-label={label}
					side="top"
					align="start"
					sideOffset={4}
					collisionPadding={8}
				>
					{children}
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
