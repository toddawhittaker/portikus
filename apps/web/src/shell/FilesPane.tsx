import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { ChecksPane } from "../checks/ChecksPane.js";
import "../checks/checks.css";
import { FileTreePane } from "../files/FileTree.js";
import { SearchPanel } from "../search/SearchPanel.js";

/** The two things the right pane can show (SPEC.md §8.4, §18.1). */
type Tab = "files" | "checks";

/**
 * The right pane (SPEC.md §8.4): one project's file tree, its checks
 * (SPEC.md §18.1), find in files (SPEC.md §11.5), or nothing to show.
 */
export function FilesPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project | undefined;
}) {
	const [searching, setSearching] = useState(false);
	const [tab, setTab] = useState<Tab>("files");
	const open = project !== undefined && !project.missing;

	// Mod+Shift+F opens find in files from anywhere in the workspace
	// (SPEC.md §11.5). With no project open there is nothing to search.
	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			setTab("files");
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

	if (open && searching) {
		return (
			<aside className="pk-pane pk-pane--right" aria-label="Find in files">
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
		return (
			<div className="pk-right-pane">
				<div className="pk-pane-tabs" role="tablist" aria-label="Files or checks">
					<Switcher current={tab} value="files" label="Files" onPick={setTab} />
					<Switcher current={tab} value="checks" label="Checks" onPick={setTab} />
				</div>
				{tab === "files" ? (
					// Keyed by project, so nothing (focus above all) carries across a switch.
					<FileTreePane
						key={project.id}
						workspaceId={workspaceId}
						project={project}
						onSearch={() => setSearching(true)}
					/>
				) : (
					<aside className="pk-pane pk-pane--right" aria-label="Checks">
						<ChecksPane key={project.id} workspaceId={workspaceId} project={project} />
					</aside>
				)}
			</div>
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

function Switcher({
	current,
	value,
	label,
	onPick,
}: {
	current: Tab;
	value: Tab;
	label: string;
	onPick: (tab: Tab) => void;
}) {
	return (
		<button
			type="button"
			role="tab"
			className="pk-pane-tab"
			aria-selected={current === value}
			data-testid={`right-pane-tab-${value}`}
			onClick={() => onPick(value)}
		>
			{label}
		</button>
	);
}
