import type { Project } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot, useToast } from "@portikus/ui";
import { useDeleteProject } from "./queries.js";

/**
 * Deleting a project removes its folder for good (SPEC.md §7.3), so the
 * student types the folder name back before the button turns on.
 */
export function DeleteConfirm({
	workspaceId,
	project,
	onClose,
	onDeleted,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const remove = useDeleteProject(workspaceId);
	const toast = useToast();

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-delete-project"
				inputTestId="delete-confirm-input"
				confirmTestId="delete-confirm-button"
				title={`Delete ${project.name}`}
				description={
					<>
						The folder <span className="pk-mono-small">{project.path}</span> and
						everything in it is removed. This cannot be undone.
					</>
				}
				confirmText={project.slug}
				confirmLabel="Delete project"
				pending={remove.isPending}
				onCancel={onClose}
				onConfirm={() => {
					if (remove.isPending) return;
					remove.mutate(
						{ projectId: project.id, slug: project.slug },
						{
							onSuccess: () => {
								toast.show({ tone: "success", title: "Project deleted" });
								onDeleted();
							},
						},
					);
				}}
			/>
		</ConfirmDialogRoot>
	);
}
