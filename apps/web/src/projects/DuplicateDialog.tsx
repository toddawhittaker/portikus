import { type Project, slugify } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { DialogError } from "./DialogError.js";
import { useDuplicateProject } from "./queries.js";

/** Copy a project into a new folder (SPEC.md §7.3). */
export function DuplicateDialog({
	workspaceId,
	project,
	onClose,
	onDuplicated,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
	onDuplicated: (project: Project) => void;
}) {
	const [name, setName] = useState(`${project.name} copy`);
	const duplicate = useDuplicateProject(workspaceId);
	const slug = slugify(name);

	function submit() {
		if (duplicate.isPending || slug === "") return;
		duplicate.mutate({ projectId: project.id, name }, { onSuccess: onDuplicated });
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-duplicate-project"
				title="Duplicate project"
				description={`A copy of ${project.name}, with its own folder.`}
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="primary"
							loading={duplicate.isPending}
							disabled={slug === "" || duplicate.isPending}
							onClick={submit}
						>
							{duplicate.isPending ? "Duplicating…" : "Duplicate project"}
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
						label="Name for the copy"
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
				<DialogError error={duplicate.error} />
			</Dialog>
		</DialogRoot>
	);
}
