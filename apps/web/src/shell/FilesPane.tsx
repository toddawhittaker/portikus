import type { Project } from "@portikus/contracts";
import {
	EmptyState,
	IconButton,
	TabsContent,
	TabsList,
	TabsRoot,
	TabsTrigger,
} from "@portikus/ui";
import { type Ref, useEffect, useRef, useState } from "react";
import { ChecksPane } from "../checks/ChecksPane.js";
import { FileTreePane } from "../files/FileTree.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { MonitorPane } from "../monitor/MonitorPane.js";
import { RunningPane } from "../running/RunningPane.js";
import { SearchPanel } from "../search/SearchPanel.js";
import { type RightPane, useRightPaneState } from "./rightPane.js";
import "./right-pane.css";

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
	const { pane, show, monitorFocus, setMonitorFocus } = useRightPaneState();
	const open = project !== undefined && !project.missing;
	// Closing the search hands focus back to the button that opened it,
	// or to the chosen surface's tab when the pane has moved off Files meanwhile.
	const searchButton = useRef<HTMLButtonElement>(null);
	const currentTab = useRef<HTMLButtonElement>(null);
	const refocus = useRef(false);

	function closeSearch() {
		refocus.current = true;
		setSearching(false);
	}

	useEffect(() => {
		if (searching || !refocus.current) return;
		refocus.current = false;
		(searchButton.current ?? currentTab.current)?.focus();
	}, [searching]);

	// A notice or the status bar opened Monitor: the search would hide its tab, so it closes.
	if (monitorFocus && searching) setSearching(false);

	// Then focus Monitor's visible tab (SPEC.md §25.8).
	useEffect(() => {
		if (!monitorFocus || searching || pane !== "monitor") return;
		setMonitorFocus(false);
		currentTab.current?.focus();
	}, [monitorFocus, searching, pane, setMonitorFocus]);

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
			<TabsRoot
				className="pk-right-pane"
				value={pane}
				onValueChange={(value) => show(value as RightPane)}
			>
				<Switchers show={show} current={pane} currentRef={currentTab} />
				<TabsContent value="files" className="pk-pane-panel">
					{/* Keyed by project, so nothing (focus above all) carries across a switch. */}
					<FileTreePane
						key={project.id}
						workspaceId={workspaceId}
						project={project}
						onSearch={() => setSearching(true)}
						searchButtonRef={searchButton}
					/>
				</TabsContent>
				<TabsContent value="checks" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Checks">
						<ChecksPane key={project.id} workspaceId={workspaceId} project={project} />
					</aside>
				</TabsContent>
				<TabsContent value="running" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Running">
						<RunningSurface workspaceId={workspaceId} projectId={project.id} />
					</aside>
				</TabsContent>
				<TabsContent value="monitor" className="pk-pane-panel">
					<aside className="pk-pane pk-pane--right" aria-label="Monitor">
						<MonitorPane workspaceId={workspaceId} />
					</aside>
				</TabsContent>
			</TabsRoot>
		);
	}

	// With no project open there is no file tree and no checks, but a port may
	// still be listening, so the Running surface stays reachable.
	return (
		<TabsRoot
			className="pk-right-pane"
			value={pane === "checks" ? "files" : pane}
			onValueChange={(value) => show(value as RightPane)}
		>
			<Switchers
				show={show}
				current={pane === "checks" ? "files" : pane}
				currentRef={currentTab}
			/>
			<TabsContent value="running" className="pk-pane-panel">
				<aside className="pk-pane pk-pane--right" aria-label="Running">
					<RunningSurface workspaceId={workspaceId} projectId={undefined} />
				</aside>
			</TabsContent>
			<TabsContent value="monitor" className="pk-pane-panel">
				<aside className="pk-pane pk-pane--right" aria-label="Monitor">
					<MonitorPane workspaceId={workspaceId} />
				</aside>
			</TabsContent>
			<TabsContent value="files" className="pk-pane-panel">
				<aside className="pk-pane pk-pane--right" aria-label="Files">
					<div className="pk-pane-head pk-pane-head--actions">
						<h2 className="sr-only">Files</h2>
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
			</TabsContent>
		</TabsRoot>
	);
}

/**
 * The switcher: Radix Tabs, so the arrow keys move between surfaces and the
 * whole strip is one Tab stop.
 */
function Switchers({
	show,
	current,
	currentRef,
}: {
	show: (pane: RightPane) => void;
	current: RightPane;
	currentRef: Ref<HTMLButtonElement>;
}) {
	const refFor = (value: RightPane) => (value === current ? currentRef : undefined);
	const list = useRef<HTMLDivElement>(null);
	// The strip scrolls sideways in a narrow pane; keep the chosen surface in view,
	// however it was chosen (a notice can open Monitor). Scrolled by hand, because
	// Chrome's scrollIntoView moves the Tab starting point and the page's first
	// Tab stop (the screen-reader toggle) would be skipped.
	useEffect(() => {
		const strip = list.current;
		const tab = strip?.querySelector<HTMLElement>(
			`[data-testid="right-pane-tab-${current}"]`,
		);
		if (!strip || !tab) return;
		const start = tab.offsetLeft - strip.offsetLeft;
		const end = start + tab.offsetWidth;
		if (start < strip.scrollLeft) strip.scrollLeft = start;
		else if (end > strip.scrollLeft + strip.clientWidth)
			strip.scrollLeft = end - strip.clientWidth;
	}, [current]);
	return (
		<TabsList
			ref={list}
			className="pk-pane-tabs"
			aria-label="Files, checks, running services or monitor"
			// The wheel scrolls the strip sideways, as the work-area tabs do.
			onWheel={(event) => {
				if (!list.current || event.deltaY === 0 || event.deltaX !== 0) return;
				list.current.scrollLeft += event.deltaY;
			}}
		>
			<Switcher value="files" buttonRef={refFor("files")} label="Files" onPick={show} />
			<Switcher
				value="checks"
				buttonRef={refFor("checks")}
				label="Checks"
				onPick={show}
			/>
			<Switcher
				value="running"
				buttonRef={refFor("running")}
				label="Running"
				onPick={show}
			/>
			<Switcher
				value="monitor"
				buttonRef={refFor("monitor")}
				label="Monitor"
				onPick={show}
			/>
		</TabsList>
	);
}

function Switcher({
	value,
	label,
	onPick,
	buttonRef,
}: {
	value: RightPane;
	buttonRef?: Ref<HTMLButtonElement>;
	label: string;
	onPick: (pane: RightPane) => void;
}) {
	return (
		<TabsTrigger
			ref={buttonRef}
			value={value}
			className="pk-pane-tab"
			data-testid={`right-pane-tab-${value}`}
			// Radix selects on mouse down; a click from assistive technology arrives alone.
			onClick={() => onPick(value)}
		>
			{label}
		</TabsTrigger>
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
		<RunningPane
			workspaceId={workspaceId}
			activePort={projectId ? activePort : null}
			onOpenPreview={(port) => {
				if (projectId) store.getState().openPreview(port);
			}}
		/>
	);
}
