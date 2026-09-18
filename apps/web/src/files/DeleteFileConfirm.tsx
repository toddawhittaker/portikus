/**
 * Confirm deleting the selection (SPEC.md §11.2). One file says its path; a
 * directory says it takes everything inside it; several say how many and
 * name the first few.
 */
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import type { FileNode } from "./FileTree.js";
import { displayName } from "./paths.js";

/** How many names a multiple-delete confirmation spells out. */
const NAMES_SHOWN = 3;

/** The sentence under the title, for one node or for many. */
export function deleteDescription(nodes: readonly FileNode[]): string {
	const first = nodes[0];
	if (nodes.length === 1 && first) {
		return first.isDir
			? `${displayName(first.path)} and everything inside it is removed. This cannot be undone.`
			: `${displayName(first.path)} is removed. This cannot be undone.`;
	}
	const shown = nodes.slice(0, NAMES_SHOWN).map((node) => displayName(node.name));
	const rest = nodes.length - shown.length;
	const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
	return `${nodes.length} items are removed: ${list}. A folder takes everything inside it. This cannot be undone.`;
}

export function DeleteFileConfirm({
	nodes,
	pending,
	onClose,
	onConfirm,
}: {
	nodes: readonly FileNode[];
	pending?: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const first = nodes[0];
	if (!first) return null;
	const title =
		nodes.length === 1
			? `Delete ${displayName(first.name)}`
			: `Delete ${nodes.length} items`;

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-delete-file"
				title={title}
				description={deleteDescription(nodes)}
				confirmLabel="Delete"
				pending={pending}
				onCancel={onClose}
				onConfirm={onConfirm}
			/>
		</ConfirmDialogRoot>
	);
}
