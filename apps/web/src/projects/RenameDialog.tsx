import { type Project, slugify } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { DialogError } from "./DialogError.js";
import { useRenameProject } from "./queries.js";

/**
 * Rename a project (SPEC.md §7.3). The name decides the slug, and the slug
 * is the folder, so the new path is shown before confirming.
 */
export function RenameDialog({
	workspaceId,
	project,
	onClose,
	onRenamed,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
	onRenamed: (project: Project) => void;
}) {
	const [name, setName] = useState(project.name);
	const rename = useRenameProject(workspaceId);
	const slug = slugify(name);

	function submit() {
		if (rename.isPending || slug === "") return;
		rename.mutate({ projectId: project.id, name }, { onSuccess: onRenamed });
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-rename-project"
				title="Rename project"
				description="The folder is renamed too."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="dialog-confirm"
							variant="primary"
							loading={rename.isPending}
							disabled={slug === "" || rename.isPending}
							onClick={submit}
						>
							{rename.isPending ? "Renaming…" : "Rename project"}
						</Button>
					</>
				}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<TextField
						id="field-name"
						data-testid="field-name"
						label="Project name"
						value={name}
						autoFocus
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => setName(event.target.value)}
						hint={
							<span data-testid="slug-preview" className="pk-mono-small">
								{slug === "" ? "~/projects/…" : `~/projects/${slug}`}
							</span>
						}
					/>
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
				</form>
				<DialogError error={rename.error} />
			</Dialog>
		</DialogRoot>
	);
}
