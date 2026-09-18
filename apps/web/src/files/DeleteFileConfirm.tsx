/**
 * Confirm deleting one file or directory (SPEC.md §11.2). A directory takes
 * everything inside it, so it says so.
 */
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import type { FileNode } from "./FileTree.js";

export function DeleteFileConfirm({
	node,
	pending,
	onClose,
	onConfirm,
}: {
	node: FileNode;
	pending?: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-delete-file"
				title={`Delete ${node.name}`}
				description={
					node.isDir
						? `${node.path} and everything inside it is removed. This cannot be undone.`
						: `${node.path} is removed. This cannot be undone.`
				}
				confirmLabel="Delete"
				pending={pending}
				onCancel={onClose}
				onConfirm={onConfirm}
			/>
		</ConfirmDialogRoot>
	);
}
