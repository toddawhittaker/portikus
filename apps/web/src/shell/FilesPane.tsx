import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";
import { FileTreePane } from "../files/FileTree.js";

/** The right pane (SPEC.md §8.4): one project's file tree, or nothing to show. */
export function FilesPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project | undefined;
}) {
	if (project && !project.missing) {
		return <FileTreePane workspaceId={workspaceId} project={project} />;
	}
	return (
		<aside className="pk-pane pk-pane--right" aria-label="Files">
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Files</h2>
				<IconButton icon="plus" label="New file or folder" size="sm" disabled />
				<IconButton icon="search" label="Find in files" size="sm" disabled />
				<IconButton icon="more" label="More file actions" size="sm" disabled />
			</div>
			{project && <div className="pk-pane-sub">~/projects/{project.slug}</div>}
			<div className="pk-pane-body">
				<EmptyState icon="folder" title="No project open">
					Choose a project to see its files.
				</EmptyState>
			</div>
		</aside>
	);
}
