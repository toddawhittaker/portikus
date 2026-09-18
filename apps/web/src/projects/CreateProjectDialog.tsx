import { type Project, slugify } from "@portikus/contracts";
import { Button, Checkbox, Dialog, DialogRoot, Select, TextField } from "@portikus/ui";
import { useState } from "react";
import { cloneUrlForRequest, projectNameFromCloneUrl } from "./cloneUrl.js";
import { DialogError } from "./DialogError.js";
import { useCreateProject, useProjectTemplates } from "./queries.js";

export type CreateMode = "new" | "clone" | "template";

const TITLE: Record<CreateMode, string> = {
	new: "New project",
	clone: "Clone repository",
	template: "New project from a template",
};

/**
 * Create a project (SPEC.md §7.2). The slug preview shows the folder the
 * project will get before anything is written, because the folder name is
 * what the student sees in a terminal.
 */
export function CreateProjectDialog({
	workspaceId,
	mode: initialMode,
	onClose,
	onCreated,
}: {
	workspaceId: string;
	mode: CreateMode;
	onClose: () => void;
	onCreated: (project: Project) => void;
}) {
	const [mode, setMode] = useState<CreateMode>(initialMode);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [template, setTemplate] = useState("");
	// Once the student types a name, pasting another URL must not overwrite it.
	const [nameEdited, setNameEdited] = useState(false);
	const [gitInit, setGitInit] = useState(true);
	const templates = useProjectTemplates(workspaceId);
	const create = useCreateProject(workspaceId);

	const slug = slugify(name);
	const modeOptions = [
		{ value: "new", label: "New project" },
		{ value: "clone", label: "Clone repository" },
		...((templates.data ?? []).length > 0
			? [{ value: "template", label: "From template" }]
			: []),
	];

	function submit() {
		if (create.isPending) return;
		create.mutate(
			{
				name,
				source: mode,
				gitInit: mode === "new" ? gitInit : true,
				...(mode === "clone" ? { url: cloneUrlForRequest(url) } : {}),
				...(mode === "template" ? { template } : {}),
			},
			{ onSuccess: onCreated },
		);
	}

	const ready =
		slug !== "" &&
		(mode !== "clone" || url.trim() !== "") &&
		(mode !== "template" || template !== "");

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-create-project"
				title={TITLE[mode]}
				description="Projects live in ~/projects in your workspace."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="dialog-confirm"
							variant="primary"
							loading={create.isPending}
							disabled={!ready || create.isPending}
							onClick={submit}
						>
							{create.isPending
								? mode === "clone"
									? "Cloning…"
									: "Creating…"
								: mode === "clone"
									? "Clone repository"
									: "Create project"}
						</Button>
					</>
				}
			>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<fieldset className="m-0 grid gap-1.5 border-0 p-0">
						<legend className="pk-text-label mb-1.5 text-ink">What to create</legend>
						<div className="flex gap-1">
							{modeOptions.map((option) => (
								<Button
									key={option.value}
									type="button"
									size="sm"
									variant={mode === option.value ? "secondary" : "quiet"}
									aria-pressed={mode === option.value}
									onClick={() => setMode(option.value as CreateMode)}
								>
									{option.label}
								</Button>
							))}
						</div>
					</fieldset>
					{/* In clone mode the URL comes first: a student pastes it and the
					    name and slug follow from it (SPEC.md §7.2). */}
					{mode === "clone" && (
						<TextField
							id="field-url"
							data-testid="field-url"
							label="Repository URL"
							mono
							value={url}
							autoFocus
							autoComplete="off"
							spellCheck={false}
							placeholder="https://github.com/owner/repo.git"
							onChange={(event) => {
								setUrl(event.target.value);
								if (nameEdited) return;
								const derived = projectNameFromCloneUrl(event.target.value);
								setName(derived);
							}}
							hint="An https, ssh or user@host:path Git URL."
						/>
					)}
					<TextField
						id="field-name"
						data-testid="field-name"
						label="Project name"
						value={name}
						autoFocus={mode !== "clone"}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => {
							setName(event.target.value);
							setNameEdited(true);
						}}
						hint={
							<span data-testid="slug-preview" className="pk-mono-small">
								{slug === "" ? "~/projects/…" : `~/projects/${slug}`}
							</span>
						}
					/>
					{mode === "template" && (
						<div data-testid="field-template">
							<Select
								id="field-template-select"
								label="Template"
								placeholder="Choose a template"
								options={(templates.data ?? []).map((item) => ({
									value: item.name,
									label: item.name,
								}))}
								value={template}
								onValueChange={setTemplate}
							/>
						</div>
					)}
					{mode === "new" && (
						<div data-testid="field-git-init">
							<Checkbox
								label="Initialize a Git repository"
								description="Source control is part of the normal Portikus workflow."
								checked={gitInit}
								onChange={(event) => setGitInit(event.target.checked)}
							/>
						</div>
					)}
					{/* Enter submits the form even though the button is in the footer. */}
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
				</form>
				<DialogError error={create.error} />
			</Dialog>
		</DialogRoot>
	);
}
