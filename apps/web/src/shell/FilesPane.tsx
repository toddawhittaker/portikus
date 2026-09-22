import type { Project } from "@portikus/contracts";
import { EmptyState, IconButton } from "@portikus/ui";
import * as RadixTabs from "@radix-ui/react-tabs";
import { useEffect, useRef, useState } from "react";
import { ChecksPane } from "../checks/ChecksPane.js";
import "../checks/checks.css";
import { FileTreePane } from "../files/FileTree.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { MonitorPane } from "../monitor/MonitorPane.js";
import { RunningPane } from "../running/RunningPane.js";
import { SearchPanel } from "../search/SearchPanel.js";
import { type RightPane, useRightPaneState } from "./rightPane.js";

/**
 * The right pane (SPEC.md §8.4): one project's file tree, its checks
 * (SPEC.md §18.1), the Running surface (SPEC.md §18.2), workspace usage
 * (SPEC.md §18.3), find in files (SPEC.md §11.5), or nothing to show.
 */
export function FilesPane({
	workspaceId,
	project,
}: {
	workspaceId: string;
	project: Project | undefined;
}) {
	const [searching, setSearching] = useState(false);
	// The chosen surface lives above this pane, because a Preview tab can ask
	// for the Running surface too (BROWSER-HANDLING.md §12).
	const { pane, show } = useRightPaneState();
	const open = project !== undefined && !project.missing;
	const root = useRef<HTMLDivElement>(null);
	// Closing the search hands focus back to the button that opened it (issue #358).
	const refocus = useRef(false);

	function closeSearch() {
		refocus.current = true;
		setSearching(false);
	}

	useEffect(() => {
		if (searching || !refocus.current) return;
		refocus.current = false;
		root.current?.querySelector<HTMLElement>('[data-testid="search-open"]')?.focus();
	}, [searching]);

	// Mod+Shift+F opens find in files from anywhere in the workspace
	// (SPEC.md §11.5). With no project open there is nothing to search.
	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			show("files");
			setSearching(true);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, show]);

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
						onClick={closeSearch}
					/>
				</div>
				<SearchPanel
					key={project.id}
					workspaceId={workspaceId}
					projectId={project.id}
					onClose={closeSearch}
				/>
			</aside>
		);
	}

	if (open) {
		return (
			<RadixTabs.Root
				ref={root}
				className="pk-right-pane"
				value={pane}
				onValueChange={(value) => show(value as RightPane)}
			>
				<Switchers show={show} />
				<RadixTabs.Content value="files" className="pk-pane-panel">
					{/* Keyed by project, so nothing (focus above all) carries across a switch. */}
					<FileTreePane
						key={project.id}
						workspaceId={workspaceId}
						project={project}
						onSearch={() => setSearching(true)}
					/>
				</RadixTabs.Content>
				<RadixTabs.Content value="checks" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Checks">
						<ChecksPane key={project.id} workspaceId={workspaceId} project={project} />
					</aside>
				</RadixTabs.Content>
				<RadixTabs.Content value="running" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Running">
						<RunningSurface workspaceId={workspaceId} projectId={project.id} />
					</aside>
				</RadixTabs.Content>
				<RadixTabs.Content value="monitor" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Monitor">
						<MonitorPane workspaceId={workspaceId} />
					</aside>
				</RadixTabs.Content>
			</RadixTabs.Root>
		);
	}

	// With no project open there is no file tree and no checks, but a port may
	// still be listening, so the Running surface stays reachable.
	return (
		<RadixTabs.Root
			ref={root}
			className="pk-right-pane"
			value={pane === "checks" ? "files" : pane}
			onValueChange={(value) => show(value as RightPane)}
		>
			<Switchers show={show} />
			<RadixTabs.Content value="running" className="pk-pane-panel">
				<aside className="pk-pane pk-pane--right" aria-label="Running">
					<RunningSurface workspaceId={workspaceId} projectId={undefined} />
				</aside>
			</RadixTabs.Content>
			<RadixTabs.Content value="monitor" className="pk-pane-panel">
				<aside className="pk-pane pk-pane--right" aria-label="Monitor">
					<MonitorPane workspaceId={workspaceId} />
				</aside>
			</RadixTabs.Content>
			<RadixTabs.Content value="files" className="pk-pane-panel">
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
			</RadixTabs.Content>
		</RadixTabs.Root>
	);
}

/**
 * The switcher: Radix Tabs, so the arrow keys move between surfaces and the
 * whole strip is one Tab stop (issue #365).
 */
function Switchers({ show }: { show: (pane: RightPane) => void }) {
	return (
		<RadixTabs.List
			className="pk-pane-tabs"
			aria-label="Files, checks, running services or monitor"
		>
			<Switcher value="files" label="Files" onPick={show} />
			<Switcher value="checks" label="Checks" onPick={show} />
			<Switcher value="running" label="Running" onPick={show} />
			<Switcher value="monitor" label="Monitor" onPick={show} />
		</RadixTabs.List>
	);
}

function Switcher({
	value,
	label,
	onPick,
}: {
	value: RightPane;
	label: string;
	onPick: (pane: RightPane) => void;
}) {
	return (
		<RadixTabs.Trigger
			value={value}
			className="pk-pane-tab"
			data-testid={`right-pane-tab-${value}`}
			// Radix selects on mouse down; a click from assistive technology arrives alone.
			onClick={() => onPick(value)}
		>
			{label}
		</RadixTabs.Trigger>
	);
}

/**
 * The Running surface, wired to the layout of the open project so that Open
 * preview lands as a tab and the preview in view can be marked.
 */
function RunningSurface({
	workspaceId,
	projectId,
}: {
	workspaceId: string;
	projectId: string | undefined;
}) {
	const store = useLayoutStore(projectId ?? "none");
	const layout = useLayout(store, (state) => state.layout);
	const activeTabId = useLayout(store, (state) => state.activeTabId);
	const activeTab = layout.tabs.find((tab) => tab.id === activeTabId);
	const activePort =
		activeTab && activeTab.root.type === "preview" ? activeTab.root.port : null;
	return (
		<>
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">Running</h2>
			</div>
			<RunningPane
				workspaceId={workspaceId}
				activePort={projectId ? activePort : null}
				onOpenPreview={(port) => {
					if (projectId) store.getState().openPreview(port);
				}}
			/>
		</>
	);
}
