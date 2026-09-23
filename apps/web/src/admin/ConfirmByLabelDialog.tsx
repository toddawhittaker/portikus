import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import type * as React from "react";

/**
 * A destructive confirmation that stays locked until the administrator types
 * the workspace label exactly (SPEC.md §16.4, §17.2).
 */
export function ConfirmByLabelDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	label,
	pending,
	onConfirm,
	testId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	confirmLabel: string;
	label: string;
	pending: boolean;
	onConfirm: () => void;
	testId: string;
}) {
	return (
		<ConfirmDialogRoot open={open} onOpenChange={onOpenChange}>
			<ConfirmDialog
				id={testId}
				testId={testId}
				title={title}
				description={description}
				confirmLabel={confirmLabel}
				confirmText={label}
				pending={pending}
				onConfirm={onConfirm}
			/>
		</ConfirmDialogRoot>
	);
}
