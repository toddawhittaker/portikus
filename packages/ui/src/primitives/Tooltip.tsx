import * as RadixTooltip from "@radix-ui/react-tooltip";
import type * as React from "react";

// Set while a closing menu hands focus back to its trigger.
let focusFromMenu = false;

/**
 * The next focus, if it lands on a Tooltip trigger now, does not open its
 * tooltip. A menu calls this as it returns focus to its trigger, so the
 * name does not pop up over the neighbouring control.
 */
export function skipTooltipOnReturnedFocus(): void {
	focusFromMenu = true;
	queueMicrotask(() => {
		focusFromMenu = false;
	});
}

export interface TooltipProps {
	/** The one element the tooltip belongs to. */
	children: React.ReactElement;
	content: React.ReactNode;
	/** Controls whether the tooltip is open; omit to let hover and focus decide. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/**
	 * For a trigger whose name already says the same words: the tooltip is
	 * for sighted users and adds no description, so a screen reader reads
	 * the words once.
	 */
	decorative?: boolean;
}

/** A brief label that opens on hover and on keyboard focus (SPEC.md section 25.8). */
export function Tooltip({
	children,
	content,
	open,
	onOpenChange,
	decorative = false,
}: TooltipProps): React.ReactElement {
	return (
		<RadixTooltip.Provider delayDuration={400}>
			<RadixTooltip.Root open={open} onOpenChange={onOpenChange}>
				<RadixTooltip.Trigger
					asChild={true}
					onFocus={(event) => {
						// Radix skips its open when the event is default-prevented.
						if (focusFromMenu) event.preventDefault();
					}}
				>
					{children}
				</RadixTooltip.Trigger>
				<RadixTooltip.Portal>
					<RadixTooltip.Content
						sideOffset={6}
						// Radix links the trigger to the tooltip as its description; a blank
						// label makes that description empty.
						{...(decorative ? { "aria-label": " ", "aria-hidden": true } : null)}
						className="pk-tooltip z-[var(--z-menu)] inline-flex items-center gap-2 whitespace-nowrap rounded-sm bg-surface-inverse px-2 py-1 text-[12px] font-medium leading-4 text-ink-inverse shadow-md"
					>
						{content}
					</RadixTooltip.Content>
				</RadixTooltip.Portal>
			</RadixTooltip.Root>
		</RadixTooltip.Provider>
	);
}
