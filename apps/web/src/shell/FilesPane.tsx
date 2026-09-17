import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";

/** The right pane. The file tree itself arrives in Epic 7 (SPEC.md §8.4). */
export function FilesPane({ project }: { project: Project | undefined }) {
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
				<EmptyState icon="file" title="Files arrive in Epic 7">
					Use a terminal to work with files for now.
				</EmptyState>
			</div>
		</aside>
	);
}
