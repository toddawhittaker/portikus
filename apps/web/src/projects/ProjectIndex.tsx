import { Button, EmptyState } from "@portikus/ui";
import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { type CreateMode, CreateProjectDialog } from "./CreateProjectDialog.js";
import { useProjects } from "./queries.js";

/**
 * `/workspaces/$id` with no project chosen: open the first active project,
 * or invite the student to make one (SPEC.md §7.2).
 */
export function ProjectIndex() {
	const { id } = useParams({ from: "/workspaces/$id" });
	const projects = useProjects(id, "active");

	if (projects.isPending) return <div className="flex-1" aria-busy="true" />;

	const first = projects.data?.[0];
	if (first) {
		return (
			<Navigate
				to="/workspaces/$id/projects/$projectId"
				params={{ id, projectId: first.id }}
				replace
			/>
		);
	}
	return <EmptyProjects workspaceId={id} />;
}

function EmptyProjects({ workspaceId }: { workspaceId: string }) {
	const navigate = useNavigate();
	const [mode, setMode] = useState<CreateMode | null>(null);

	return (
		<div
			className="flex flex-1 items-center justify-center p-10"
			data-testid="empty-projects"
		>
			<EmptyState
				icon="folder"
				title="Create your first project"
				actions={
					<>
						<Button variant="primary" onClick={() => setMode("new")}>
							New project
						</Button>
						<Button variant="secondary" onClick={() => setMode("clone")}>
							Clone repository
						</Button>
					</>
				}
			>
				Projects live in ~/projects in your workspace. Everything you make here stays
				there.
			</EmptyState>
			{mode && (
				<CreateProjectDialog
					workspaceId={workspaceId}
					mode={mode}
					onClose={() => setMode(null)}
					onCreated={(project) => {
						setMode(null);
						void navigate({
							to: "/workspaces/$id/projects/$projectId",
							params: { id: workspaceId, projectId: project.id },
						});
					}}
				/>
			)}
		</div>
	);
}
