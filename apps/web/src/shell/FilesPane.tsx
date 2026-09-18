import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";
import { useEffect, useState } from "react";
import { FileTreePane } from "../files/FileTree.js";
import { SearchPanel } from "../search/SearchPanel.js";

/**
 * The right pane (SPEC.md §8.4): one project's file tree, find in files
 * (SPEC.md §11.5), or nothing to show.
 */
export function FilesPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project | undefined;
}) {
	const [searching, setSearching] = useState(false);

	// Mod+Shift+F opens find in files from anywhere in the workspace
	// (SPEC.md §11.5).
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			setSearching(true);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const open = project !== undefined && !project.missing;

	if (open && searching) {
		return (
			<aside className="pk-pane pk-pane--right" aria-label="Files">
				<div className="pk-pane-head">
					<h2 className="pk-pane-title">Find in files</h2>
					<IconButton
						icon="x"
						label="Close search"
						size="sm"
						data-testid="search-close"
						onClick={() => setSearching(false)}
					/>
				</div>
				<SearchPanel
					workspaceId={workspaceId}
					projectId={project.id}
					onClose={() => setSearching(false)}
				/>
			</aside>
		);
	}

	if (open) {
		// Keyed by project, so nothing (focus above all) carries across a switch.
		return (
			<FileTreePane
				key={project.id}
				workspaceId={workspaceId}
				project={project}
				onSearch={() => setSearching(true)}
			/>
		);
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
