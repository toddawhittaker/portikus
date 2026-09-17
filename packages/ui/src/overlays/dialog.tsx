import * as RadixDialog from "@radix-ui/react-dialog";
import type * as React from "react";
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
	onClose?: () => void;
	role?: "dialog" | "alertdialog";
	/** Test hook: set as `data-testid` on the dialog surface. */
	testId?: string;
}

/**
 * The styled modal. Render it inside a DialogRoot; Radix owns the focus trap,
 * Escape and the return of focus to the trigger.
 */
export function Dialog({
	id,
	title,
	description,
	children,
	footer,
	size,
	onClose,
	role,
	testId,
}: DialogProps): React.ReactElement {
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
					event.preventDefault();
					(event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
				}}
				className={`pk-dialog ${size === "lg" ? "pk-dialog--lg" : ""}`}
			>
				<div className="flex items-start gap-3 px-6 pt-6">
					<div>
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
				{children ? <div className="px-6 pt-4">{children}</div> : null}
				{footer ? <div className="flex justify-end gap-2 p-6">{footer}</div> : null}
			</RadixDialog.Content>
		</RadixDialog.Portal>
	);
}
