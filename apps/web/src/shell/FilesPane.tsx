import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { FileTreePane } from "../files/FileTree.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { RunningPane } from "../running/RunningPane.js";
import { SearchPanel } from "../search/SearchPanel.js";
import { type RightPane, useRightPane } from "./rightPane.js";

/**
 * The right pane (SPEC.md §8.4): one project's file tree, find in files
 * (SPEC.md §11.5), the Running surface (SPEC.md §18.2), or nothing to show.
 */
export function FilesPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project | undefined;
}) {
	const [searching, setSearching] = useState(false);
	const right = useRightPane();
	const open = project !== undefined && !project.missing;

	// Mod+Shift+F opens find in files from anywhere in the workspace
	// (SPEC.md §11.5). With no project open there is nothing to search.
	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			setSearching(true);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open]);

	// Switching project leaves the search: its results belong to the old one.
	const shown = useRef(project?.id);
	if (shown.current !== project?.id) {
		shown.current = project?.id;
		setSearching(false);
	}

	if (right.pane === "running") {
		return (
			<aside className="pk-pane pk-pane--right" aria-label="Running">
				<PaneSwitch pane="running" show={right.show} />
				<RunningSurface projectId={open ? project.id : undefined} />
			</aside>
		);
	}

	if (open && searching) {
		return (
			<aside className="pk-pane pk-pane--right" aria-label="Find in files">
				<PaneSwitch pane="files" show={right.show} />
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
					key={project.id}
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
				switcher={<PaneSwitch pane="files" show={right.show} />}
			/>
		);
	}

	return (
		<aside className="pk-pane pk-pane--right" aria-label="Files">
			<PaneSwitch pane="files" show={right.show} />
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

/** The Files / Running switch at the top of the right pane (DESIGN.md). */
function PaneSwitch({
	pane,
	show,
}: {
	pane: RightPane;
	show: (pane: RightPane) => void;
}) {
	return (
		<div className="pk-pane-switch" role="tablist" aria-label="Right pane">
			<button
				type="button"
				role="tab"
				aria-selected={pane === "files"}
				data-testid="right-pane-files"
				onClick={() => show("files")}
			>
				Files
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={pane === "running"}
				data-testid="right-pane-running"
				onClick={() => show("running")}
			>
				Running
			</button>
		</div>
	);
}

/**
 * The Running surface, wired to the layout of the open project so that Open
 * preview lands as a tab and a saved preview with no listener is marked.
 */
function RunningSurface({ projectId }: { projectId: string | undefined }) {
	const store = useLayoutStore(projectId ?? "none");
	const layout = useLayout(store, (state) => state.layout);
	const previewPorts = layout.tabs
		.map((tab) => (tab.root.type === "preview" ? tab.root.port : null))
		.filter((port): port is number => port !== null);
	return (
		<>
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Running</h2>
			</div>
			<RunningPane
				previewPorts={projectId ? previewPorts : []}
				onOpenPreview={(port) => {
					if (projectId) store.getState().openPreview(port);
				}}
			/>
		</>
	);
}
