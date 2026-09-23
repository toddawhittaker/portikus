import type { Project } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useArchiveProject } from "./queries.js";

/**
 * Archiving hides a project from the active list and keeps every file
 * (SPEC.md §7.4), so the confirmation says exactly that.
 */
export function ArchiveConfirm({
	workspaceId,
	project,
	onClose,
	onArchived,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
	onArchived: () => void;
}) {
	const archive = useArchiveProject(workspaceId);

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-archive-project"
				title={`Archive ${project.name}?`}
				description="You can bring it back from Archived projects at any time. A recovery point is made first when the workspace is running."
				lost={["the project from your list"]}
				survives={[
					<span key="files">
						all files in{" "}
						<span className="pk-mono-small">~/projects/{project.slug}</span>
					</span>,
					"its recovery points",
				]}
				confirmLabel="Archive project"
				pending={archive.isPending}
				onCancel={onClose}
				onConfirm={() => {
					if (archive.isPending) return;
					archive.mutate(project.id, { onSuccess: onArchived });
				}}
			/>
		</ConfirmDialogRoot>
	);
}
