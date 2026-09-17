import type { Project } from "@portikus/contracts";
import {
	Icon,
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
} from "@portikus/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArchiveConfirm } from "./ArchiveConfirm.js";
import { type CreateMode, CreateProjectDialog } from "./CreateProjectDialog.js";
import { DuplicateDialog } from "./DuplicateDialog.js";
import {
	projectDownloadUrl,
	useGitInitProject,
	useProjects,
	useProjectTemplates,
	useUnarchiveProject,
} from "./queries.js";
import { RenameDialog } from "./RenameDialog.js";

type Open =
	| { kind: "none" }
	| { kind: "create"; mode: CreateMode }
	| { kind: "rename"; project: Project }
	| { kind: "duplicate"; project: Project }
	| { kind: "archive"; project: Project };

/** The left pane: the active projects, their actions, and the archived list (SPEC.md §8.2). */
export function ProjectPane({
	workspaceId,
	currentProjectId,
}: {
	workspaceId: string;
	currentProjectId: string | undefined;
}) {
	const navigate = useNavigate();
	const active = useProjects(workspaceId, "active");
	const archived = useProjects(workspaceId, "archived");
	const templates = useProjectTemplates(workspaceId);
	const gitInit = useGitInitProject(workspaceId);
	const unarchive = useUnarchiveProject(workspaceId);
	const [open, setOpen] = useState<Open>({ kind: "none" });
	const [showArchived, setShowArchived] = useState(false);

	const projects = active.data ?? [];

	function goTo(project: Project) {
		void navigate({
			to: "/workspaces/$id/projects/$projectId",
			params: { id: workspaceId, projectId: project.id },
		});
	}

	function afterArchive(archivedProject: Project) {
		setOpen({ kind: "none" });
		if (archivedProject.id !== currentProjectId) return;
		const next = projects.find((project) => project.id !== archivedProject.id);
		if (next) {
			goTo(next);
			return;
		}
		void navigate({ to: "/workspaces/$id", params: { id: workspaceId } });
	}

	return (
		<nav className="pk-pane pk-pane--left" aria-label="Projects">
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Projects</h2>
				<MenuRoot>
					<MenuTrigger asChild>
						<IconButton
							icon="plus"
							label="New project"
							size="sm"
							data-testid="new-project"
						/>
					</MenuTrigger>
					<Menu label="New project">
						<MenuItem
							icon="folder"
							onSelect={() => setOpen({ kind: "create", mode: "new" })}
						>
							<span data-testid="new-project-new">New project…</span>
						</MenuItem>
						<MenuItem
							icon="external"
							onSelect={() => setOpen({ kind: "create", mode: "clone" })}
						>
							<span data-testid="new-project-clone">Clone repository…</span>
						</MenuItem>
						{(templates.data ?? []).length > 0 && (
							<MenuItem
								icon="file"
								onSelect={() => setOpen({ kind: "create", mode: "template" })}
							>
								<span data-testid="new-project-template">From template…</span>
							</MenuItem>
						)}
					</Menu>
				</MenuRoot>
			</div>

			<div className="pk-pane-body">
				<ul className="pk-list" data-testid="project-list">
					{projects.map((project) => {
						const current = project.id === currentProjectId;
						return (
							<li
								key={project.id}
								className={`pk-list-item${current ? " is-current" : ""}`}
								data-testid={`project-item-${project.id}`}
							>
								<Link
									className="pk-list-row"
									to="/workspaces/$id/projects/$projectId"
									params={{ id: workspaceId, projectId: project.id }}
									aria-current={current ? "page" : undefined}
								>
									<Icon name={current ? "folder-open" : "folder"} size="md" />
									<span className="pk-list-label">{project.name}</span>
									{/* A project is a folder, so the folder name is always shown. */}
									{project.missing ? null : (
										<span
											className="pk-list-slug pk-mono-small"
											data-testid={`project-slug-${project.id}`}
										>
											{project.slug}
										</span>
									)}
									{project.missing ? (
										<span className="pk-tag pk-tag--warning">missing</span>
									) : null}
									{project.isGitRepo === false && !project.missing ? (
										<span className="pk-tag">not a repo</span>
									) : null}
								</Link>
								<MenuRoot>
									<MenuTrigger asChild>
										<IconButton
											icon="more"
											label={`Actions for ${project.name}`}
											size="sm"
											data-testid={`project-menu-${project.id}`}
										/>
									</MenuTrigger>
									<Menu label={`Actions for ${project.name}`}>
										{project.missing ? null : (
											<>
												<MenuItem onSelect={() => setOpen({ kind: "rename", project })}>
													<span data-testid="project-rename">Rename…</span>
												</MenuItem>
												<MenuItem
													onSelect={() => setOpen({ kind: "duplicate", project })}
												>
													<span data-testid="project-duplicate">Duplicate…</span>
												</MenuItem>
												<MenuItem>
													{/* A plain link so the browser streams the zip to disk. */}
													<a
														href={projectDownloadUrl(workspaceId, project.id)}
														download={`${project.slug}.zip`}
														data-testid="project-download"
													>
														Download as zip
													</a>
												</MenuItem>
												{project.isGitRepo === false && (
													<MenuItem onSelect={() => gitInit.mutate(project.id)}>
														<span data-testid="project-git-init">Initialize Git</span>
													</MenuItem>
												)}
												<MenuSeparator />
											</>
										)}
										<MenuItem
											danger
											onSelect={() => setOpen({ kind: "archive", project })}
										>
											<span data-testid="project-archive">Archive…</span>
										</MenuItem>
									</Menu>
								</MenuRoot>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="pk-pane-foot">
				<button
					type="button"
					className="pk-list-row"
					data-testid="archived-projects"
					aria-expanded={showArchived}
					onClick={() => setShowArchived((value) => !value)}
				>
					<Icon name="folder" size="md" />
					<span className="pk-list-label">Archived projects</span>
					<span className="pk-list-meta">{(archived.data ?? []).length}</span>
					<Icon name={showArchived ? "chevron-down" : "chevron-right"} size="sm" />
				</button>
				{showArchived && (
					<ul className="pk-list mt-1">
						{(archived.data ?? []).map((project) => (
							<li
								key={project.id}
								className="pk-list-item"
								data-testid={`project-item-${project.id}`}
							>
								<span className="pk-list-row">
									<Icon name="folder" size="md" />
									<span className="pk-list-label">{project.name}</span>
								</span>
								<IconButton
									icon="restart"
									label={`Unarchive ${project.name}`}
									size="sm"
									data-testid={`project-unarchive-${project.id}`}
									onClick={() => unarchive.mutate(project.id, { onSuccess: goTo })}
								/>
							</li>
						))}
						{(archived.data ?? []).length === 0 && (
							<li className="pk-list-meta px-2 py-1">No archived projects.</li>
						)}
					</ul>
				)}
			</div>

			{open.kind === "create" && (
				<CreateProjectDialog
					workspaceId={workspaceId}
					mode={open.mode}
					onClose={() => setOpen({ kind: "none" })}
					onCreated={(project) => {
						setOpen({ kind: "none" });
						goTo(project);
					}}
				/>
			)}
			{open.kind === "rename" && (
				<RenameDialog
					workspaceId={workspaceId}
					project={open.project}
					onClose={() => setOpen({ kind: "none" })}
					onRenamed={() => setOpen({ kind: "none" })}
				/>
			)}
			{open.kind === "duplicate" && (
				<DuplicateDialog
					workspaceId={workspaceId}
					project={open.project}
					onClose={() => setOpen({ kind: "none" })}
					onDuplicated={(project) => {
						setOpen({ kind: "none" });
						goTo(project);
					}}
				/>
			)}
			{open.kind === "archive" && (
				<ArchiveConfirm
					workspaceId={workspaceId}
					project={open.project}
					onClose={() => setOpen({ kind: "none" })}
					onArchived={() => afterArchive(open.project)}
				/>
			)}
		</nav>
	);
}
