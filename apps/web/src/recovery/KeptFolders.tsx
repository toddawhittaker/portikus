import {
	type Project,
	RECOVERY_ASIDE_PREFIX,
	type RecoveryAsideFolder,
} from "@portikus/contracts";
import { Button, ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useState } from "react";
import { ApiError } from "../api/request.js";
import { formatBytes } from "../monitor/format.js";
import { pointTime } from "./labels.js";
import { useDeleteRecoveryAside } from "./queries.js";

/** Where the folder is, as the student would find it in a terminal. */
function asidePath(folder: RecoveryAsideFolder): string {
	return `~/projects/${RECOVERY_ASIDE_PREFIX}${folder.pointId}`;
}

/** "3 files, 2.0 KB", marked as a lower bound when the agent stopped counting. */
function asideContents(folder: RecoveryAsideFolder): string {
	const files = `${folder.fileCount} ${folder.fileCount === 1 ? "file" : "files"}`;
	const text = `${files}, ${formatBytes(folder.sizeBytes)}`;
	return folder.complete ? text : `at least ${text}`;
}

function origin(folder: RecoveryAsideFolder): string {
	return folder.pointCreatedAt
		? `a restore to ${pointTime(folder.pointCreatedAt)}`
		: "an earlier restore";
}

/**
 * Folders a restore that stopped part way left in ~/projects. Portikus never
 * deletes them on its own, since one may hold the only copy of the files
 * (SPEC.md §15.10).
 */
export function KeptFolders({
	folders,
	onDelete,
}: {
	folders: RecoveryAsideFolder[];
	onDelete: (folder: RecoveryAsideFolder) => void;
}) {
	if (folders.length === 0) return null;
	return (
		<section className="mt-6" aria-labelledby="recovery-kept-heading">
			<h3
				id="recovery-kept-heading"
				tabIndex={-1}
				className="pk-text-body m-0 font-semibold"
			>
				Kept folders
			</h3>
			<p className="pk-text-compact m-0 mt-1 text-ink-muted">
				A restore that stopped part way keeps your earlier files here. Copy back
				anything you need, then delete the folder.
			</p>
			<ul className="m-0 mt-2 list-none p-0" data-testid="recovery-kept-list">
				{folders.map((folder) => (
					<li
						key={folder.pointId}
						className="flex flex-wrap items-center gap-3 py-1 text-[13px]"
						data-testid={`recovery-kept-${folder.pointId}`}
					>
						<span className="min-w-0 flex-1">
							<code className="break-all">{asidePath(folder)}</code>
							<span className="block text-ink-muted">
								From {origin(folder)}: {asideContents(folder)}
							</span>
						</span>
						<Button
							size="sm"
							aria-label={`Delete ${asidePath(folder)}`}
							data-testid={`recovery-kept-delete-${folder.pointId}`}
							onClick={() => onDelete(folder)}
						>
							Delete…
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Says what the folder holds before it goes for good. */
export function DeleteKeptFolderConfirm({
	workspaceId,
	project,
	folder,
	onClose,
	onDeleted,
	returnFocusTo,
}: {
	workspaceId: string;
	project: Project;
	folder: RecoveryAsideFolder;
	onClose: () => void;
	onDeleted: () => void;
	returnFocusTo: () => HTMLElement | null;
}) {
	const remove = useDeleteRecoveryAside(workspaceId, project.id);
	// Shown inside the dialog: a toast behind a modal is hidden from screen readers.
	const [failure, setFailure] = useState<string | null>(null);

	function run() {
		if (remove.isPending) return;
		setFailure(null);
		remove.mutate(folder.pointId, {
			onSuccess: onDeleted,
			onError: (error) =>
				setFailure(
					error instanceof ApiError
						? error.message
						: "The folder was not deleted. Check your connection and try again.",
				),
		});
	}

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-delete-kept-folder"
				title="Delete this kept folder?"
				description={
					<>
						{asidePath(folder)} holds the files {project.name} had before{" "}
						{origin(folder)} stopped part way: {asideContents(folder)}. Copy back
						anything you still need first.
						<span
							role="alert"
							className="mt-2 block text-status-error"
							data-testid="delete-kept-error"
						>
							{failure}
						</span>
					</>
				}
				lost={["the files in this folder, for good"]}
				survives={[`the current files in ${project.name}`, "every recovery point"]}
				confirmLabel="Delete folder"
				pending={remove.isPending}
				onCancel={onClose}
				onConfirm={run}
				returnFocusTo={returnFocusTo}
			/>
		</ConfirmDialogRoot>
	);
}
