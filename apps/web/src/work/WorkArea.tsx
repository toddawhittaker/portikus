/**
 * The centre work area: the terminal tabs, their splits, and the saved
 * layout of one project (SPEC.md §7.5, §8, §9.3, §10.2). A coding-agent
 * launcher creates an ordinary terminal and names the agent.
 */
import {
	DndContext,
	DragOverlay,
	MeasuringStrategy,
	pointerWithin,
} from "@dnd-kit/core";
import type { CodingAgent, SplitNode, Terminal } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	Menu,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuTrigger,
	type TabItem,
	Tabs,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { baseName, displayName } from "../files/paths.js";
import { useLayoutPersistence } from "../layout/persist.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import {
	filePaths,
	fileTabId,
	type SplitDirection,
	terminalIds,
} from "../layout/tree.js";
import { PreviewPicker } from "../preview/PreviewPicker.js";
import { useShowRightPane } from "../shell/rightPane.js";
import { TerminalGroup } from "../terminal/TerminalGroup.js";
import { useTerminals } from "../terminal/useTerminals.js";
import { usePointerDismiss } from "./pointerDismiss.js";
import { usePaneActions } from "./usePaneActions.js";
import { TabStripDrop, usePaneDrag } from "./usePaneDrag.js";
import "./work.css";

/**
 * Radix focuses a menu trigger when the menu closes, and that programmatic
 * focus paints the focus ring. A pointer dismiss leaves the trigger at rest.
 * A keyboard dismiss still focuses it. `declineTriggerFocus` is for an action
 * that moves the keyboard itself, so the trigger must not take it back.
 */
function useLauncherMenuFocus() {
	const { pointer, track } = usePointerDismiss();
	const launched = useRef(false);
	const open = useRef(false);

	function onOpenChange(next: boolean) {
		open.current = next;
		track(next);
	}

	function declineTriggerFocus() {
		if (open.current) launched.current = true;
	}

	function onCloseAutoFocus(event: Event) {
		const launchedFromMenu = launched.current;
		launched.current = false;
		if (pointer.current || launchedFromMenu) {
			event.preventDefault();
			pointer.current = false;
		}
	}

	return { onOpenChange, onCloseAutoFocus, declineTriggerFocus };
}

/**
 * What closing a tab would lose: edits not on disk, by file name when there
 * is one, and the terminals it ends.
 */
function closeTabWarning(unsaved: string[], terminals: number): string {
	const first = unsaved[0];
	const files =
		first === undefined
			? null
			: unsaved.length === 1
				? `${displayName(baseName(first))} has changes that are not saved.`
				: `${unsaved.length} files have changes that are not saved.`;
	const ends = terminals === 1 ? "ends its terminal" : "ends all of its terminals";
	if (files === null)
		return `It has ${terminals} terminals. Closing the tab ends them all.`;
	if (terminals === 0) return `${files} Closing the tab discards them.`;
	return `${files} Closing the tab discards them and ${ends}.`;
}

export interface WorkAreaProps {
	workspaceId: string;
	projectId: string;
	projectPath: string;
	/** A file the URL asked to open, and the line to jump to (SPEC.md §14.9). */
	openPath?: string;
	openLine?: number;
	/** A port the URL asked to preview (SPEC.md §14.6, §14.9). */
	openPreviewPort?: number;
}

export function WorkArea({
	workspaceId,
	projectId,
	projectPath,
	openPath,
	openLine,
	openPreviewPort,
}: WorkAreaProps) {
	const store = useLayoutStore(projectId);
	const layout = useLayout(store, (state) => state.layout);
	const activeTabId = useLayout(store, (state) => state.activeTabId);
	const focusedPaneId = useLayout(store, (state) => state.focusedPaneId);
	const pendingView = useLayout(store, (state) => state.pendingView);
	const diffBaseline = useLayout(store, (state) => state.diffBaseline);
	const unsavedTabs = useLayout(store, (state) => state.unsavedTabs);
	const loaded = useLayoutPersistence(workspaceId, projectId, store);
	const terminals = useTerminals(workspaceId, projectId, true);
	const [closingTabId, setClosingTabId] = useState<string | null>(null);
	// Open when set; `replacing` is a refused preview tab the choice replaces.
	const [pickingPreview, setPickingPreview] = useState<{
		replacing: string | null;
	} | null>(null);
	const showRightPane = useShowRightPane();
	const strip = useRef<HTMLDivElement | null>(null);
	const drag = usePaneDrag({
		tabs: layout.tabs,
		strip,
		moveLeaf: (tabId, dragged, target, edge) =>
			store.getState().moveLeaf(tabId, dragged, target, edge),
		moveLeafToNewTab: (dragged, index) =>
			store.getState().moveLeafToNewTab(dragged, index),
		activateTab: (tabId) => store.getState().setActive(tabId),
	});
	const { draggedPane, dragTarget } = drag;
	const launcherMenu = useLauncherMenuFocus();

	// Until both lists are in, an empty layout only means not loaded yet.
	const showEmpty =
		layout.tabs.length === 0 &&
		loaded &&
		(terminals.loaded || terminals.error !== null);
	const byId = new Map(terminals.terminals.map((terminal) => [terminal.id, terminal]));

	// Once the saved layout is in, every terminal list answer decides which
	// panes exist: new terminals get a tab, gone terminals lose their pane.
	// An ended terminal with no pane stays out of the way: it is history in the
	// listing, not a pane (SPEC.md §9.7). The two joined id lists are the
	// effect's keys, so it re-runs when a terminal appears, goes, or ends.
	const terminalIdKey = terminals.terminals.map((terminal) => terminal.id).join(",");
	const endedTerminalIds = terminals.terminals
		.filter((terminal) => terminal.endedAt != null)
		.map((terminal) => terminal.id)
		.join(",");
	useEffect(() => {
		if (!loaded || !terminals.loaded) return;
		const ids = terminalIdKey === "" ? [] : terminalIdKey.split(",");
		const ended = endedTerminalIds === "" ? [] : endedTerminalIds.split(",");
		store.getState().reconcile(ids, ended);
	}, [loaded, terminals.loaded, terminalIdKey, endedTerminalIds, store]);

	// A file the URL named opens once the saved layout is in, because loading
	// it would otherwise replace the tab this just opened.
	useEffect(() => {
		if (!loaded || !openPath) return;
		store.getState().openFile(openPath, { line: openLine });
	}, [loaded, openPath, openLine, store]);

	// A preview the URL named opens once the saved layout is in, for the same
	// reason a file does.
	useEffect(() => {
		if (!loaded || openPreviewPort === undefined) return;
		store.getState().openPreview(openPreviewPort);
	}, [loaded, openPreviewPort, store]);

	// Place the new terminal before the list is refetched, so no reconcile ever
	// sees a terminal that has no pane yet and gives it a tab of its own.
	async function createAndPlace(
		place: (created: Terminal) => void,
		init?: { agent?: CodingAgent },
	) {
		let created: Terminal | null;
		try {
			created = await terminals.create(init);
		} catch {
			created = null;
		}
		if (!created) return;
		place(created);
		terminals.refetch();
	}

	/** A new tab, with the keyboard in that terminal's pane (SPEC.md §10.2). */
	function placeFocusedTab(created: Terminal) {
		store.getState().addTab(created.id);
		store.getState().setFocused(created.id);
	}

	async function openTerminalTab() {
		await createAndPlace(placeFocusedTab);
	}

	async function openAgent(agent: CodingAgent) {
		await createAndPlace(placeFocusedTab, { agent });
	}

	async function split(terminalId: string, direction: SplitDirection) {
		await createAndPlace((created) =>
			store.getState().splitLeaf(terminalId, direction, created.id),
		);
	}

	async function replace(terminalId: string) {
		await createAndPlace((created) => {
			store.getState().replaceLeaf(terminalId, created.id);
			// The button the student clicked is gone with the ended pane, so
			// the keyboard would land on nothing. Make the new terminal the
			// focused one and its pane takes the keyboard.
			store.getState().setFocused(created.id);
		});
	}

	/**
	 * Delete the terminal and let the refreshed list remove the pane. The pane
	 * may stay for one round trip; a failure shows a toast.
	 */
	function closeTerminal(terminalId: string) {
		void terminals.close(terminalId).catch(() => {});
	}

	function launcher(): HTMLElement | null {
		return (
			strip.current?.querySelector<HTMLElement>('[data-testid="launcher"]') ?? null
		);
	}

	/** Close from the pane's menu: the keyboard moves on rather than being lost. */
	function closePane(terminalId: string) {
		panes.moveFocusOff(terminalId);
		closeTerminal(terminalId);
	}

	/**
	 * A shell that ended takes its pane away. If the student was typing in it,
	 * focus goes to the New control rather than being lost (SPEC.md §9.7).
	 * Not to a neighbour: panes that end together, as in a restart, would
	 * hand the keyboard to each other and then drop it.
	 */
	function terminalExited(terminalId: string) {
		const pane = document.querySelector(`[data-testid="terminal-pane-${terminalId}"]`);
		if (pane?.contains(document.activeElement)) launcher()?.focus();
		closeTerminal(terminalId);
	}

	function closeTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		// A file, diff or preview tab holds no process, so closing it is just
		// the tab.
		if (
			tab.root.type === "file" ||
			tab.root.type === "diff" ||
			tab.root.type === "preview"
		) {
			store.getState().closeTab(tabId);
			setClosingTabId(null);
			return;
		}
		// Files in the tab's splits close with it; its terminals go once the
		// server has ended them.
		const ids = terminalIds(tab.root);
		if (ids.length === 0) store.getState().closeTab(tabId);
		else for (const path of filePaths(tab.root)) store.getState().closeFile(path);
		for (const terminalId of ids) closeTerminal(terminalId);
		setClosingTabId(null);
	}

	/** Close a file's pane from its menu; the keyboard moves on rather than being lost. */
	function closeFile(path: string) {
		panes.moveFocusOff(fileTabId(path));
		store.getState().closeFile(path);
	}

	/** Files in the tab with edits not on disk. */
	function unsavedFiles(root: SplitNode): string[] {
		return filePaths(root).filter((path) => unsavedTabs[fileTabId(path)] ?? false);
	}

	function requestCloseTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const live = terminalIds(tab.root).filter((id) => byId.get(id)?.endedAt == null);
		if (live.length > 1 || unsavedFiles(tab.root).length > 0) {
			setClosingTabId(tabId);
			return;
		}
		closeTab(tabId);
	}

	// Mod+Alt+T opens a terminal from anywhere in the work area. The listener is
	// registered once; the ref keeps it pointed at the newest handler.
	const openTerminalTabRef = useRef(openTerminalTab);
	openTerminalTabRef.current = openTerminalTab;
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (!event.altKey || !(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "t") return;
			event.preventDefault();
			void openTerminalTabRef.current();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const items: TabItem[] = layout.tabs.map((tab) => {
		if (tab.root.type === "preview") {
			const port = tab.root.port;
			return {
				id: tab.id,
				kind: "preview" as const,
				label: `Preview ${port}`,
				title: `Preview of port ${port}`,
				testId: `tab-${tab.id}`,
			};
		}
		// A tab shows the unsaved dot when any file in it has edits not on disk.
		const files = filePaths(tab.root);
		const dirty = files.some((path) => unsavedTabs[fileTabId(path)] ?? false);
		const ids = terminalIds(tab.root);
		if (tab.root.type === "file" || tab.root.type === "diff" || ids.length === 0) {
			const path = tab.root.type === "diff" ? tab.root.path : (files[0] ?? "");
			return {
				id: tab.id,
				kind: tab.root.type === "diff" ? ("diff" as const) : ("file" as const),
				// The strip has no room for a path, so the file name is the label.
				label: displayName(baseName(path)),
				title: displayName(path),
				dirty,
				testId: `tab-${tab.id}`,
			};
		}
		const first = ids[0] ? byId.get(ids[0]) : undefined;
		// Claude Code and Codex share the agent icon and are named apart from a
		// shell (design system, Iconography). The terminal record is the source.
		const agent =
			first?.agent === "claude" || first?.agent === "codex" ? first.agent : null;
		return {
			id: tab.id,
			kind: agent ?? "terminal",
			label:
				agent === "claude"
					? "Claude Code"
					: agent === "codex"
						? "Codex"
						: (first?.name ?? "Terminal"),
			testId: `tab-${tab.id}`,
			ended: ids.length > 0 && ids.every((id) => byId.get(id)?.endedAt != null),
			dirty,
		};
	});

	const panes = usePaneActions({
		store,
		layout,
		activeTabId,
		strip,
		items,
		newControl: launcher,
		closeTab,
	});

	const closingTab = layout.tabs.find((tab) => tab.id === closingTabId);

	return (
		<DndContext
			sensors={drag.sensors}
			collisionDetection={pointerWithin}
			// A tab opened mid-drag shows panes that measured nothing when the
			// drag began, so the drop areas are measured as the drag goes.
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			{...drag.handlers}
		>
			<div className="pk-work-area" data-testid="work-area">
				<TabStripDrop strip={strip} testId="work-tabs" target={dragTarget}>
					<Tabs
						tabs={items}
						activeId={activeTabId ?? ""}
						label={`Open tabs in ${projectPath}`}
						onSelect={(id) => store.getState().setActive(id)}
						onClose={requestCloseTab}
						onReorder={(from, to) => store.getState().moveTab(from, to)}
						actions={
							<MenuRoot onOpenChange={launcherMenu.onOpenChange}>
								<MenuTrigger asChild={true}>
									<IconButton
										icon="plus"
										label="New tab"
										size="sm"
										data-testid="launcher"
										aria-haspopup="menu"
									/>
								</MenuTrigger>
								<Menu label="New tab" onCloseAutoFocus={launcherMenu.onCloseAutoFocus}>
									<MenuLabel>Open in {projectPath}</MenuLabel>
									<MenuItem
										icon="terminal"
										shortcut={["Mod", "Alt", "T"]}
										onSelect={() => {
											launcherMenu.declineTriggerFocus();
											void openTerminalTab();
										}}
									>
										<span data-testid="launcher-terminal">Terminal</span>
									</MenuItem>
									<MenuItem
										icon="agent"
										onSelect={() => {
											launcherMenu.declineTriggerFocus();
											void openAgent("claude");
										}}
									>
										<span data-testid="launcher-claude">Claude Code</span>
									</MenuItem>
									<MenuItem
										icon="agent"
										onSelect={() => {
											launcherMenu.declineTriggerFocus();
											void openAgent("codex");
										}}
									>
										<span data-testid="launcher-codex">Codex</span>
									</MenuItem>
									<MenuItem
										icon="preview"
										onSelect={() => setPickingPreview({ replacing: null })}
									>
										<span data-testid="launcher-preview">Preview</span>
									</MenuItem>
								</Menu>
							</MenuRoot>
						}
					/>
				</TabStripDrop>

				{terminals.error ? (
					<p className="pk-work-error" role="alert">
						{terminals.error}
					</p>
				) : null}

				{showEmpty ? (
					<EmptyState
						icon="terminal"
						title="No terminals open"
						actions={
							<>
								<Button
									variant="primary"
									iconStart="terminal"
									data-testid="empty-open-terminal"
									onClick={() => void openTerminalTab()}
								>
									Open a terminal
								</Button>
								<Button
									variant="secondary"
									iconStart="agent"
									data-testid="empty-open-claude"
									onClick={() => void openAgent("claude")}
								>
									Start Claude Code
								</Button>
							</>
						}
					>
						Open a terminal or start Claude Code. The + in the tab bar also opens Codex
						and previews.
					</EmptyState>
				) : (
					layout.tabs.map((tab) => (
						<TerminalGroup
							key={tab.id}
							tabId={tab.id}
							root={tab.root}
							terminals={byId}
							workspaceId={workspaceId}
							projectId={projectId}
							visible={tab.id === activeTabId}
							focusedPaneId={focusedPaneId}
							onFocus={(id) => store.getState().setFocused(id)}
							onSplit={(id, direction) => void split(id, direction)}
							onRename={(id, name) => void terminals.rename(id, name)}
							onSetTheme={(id, theme) => void terminals.setTheme(id, theme)}
							onClose={closePane}
							onExited={terminalExited}
							onReplace={(id) => void replace(id)}
							onResize={(path, sizes) => store.getState().resize(tab.id, path, sizes)}
							onShowRunning={() => showRightPane("running")}
							onChoosePreviewPort={() => setPickingPreview({ replacing: tab.id })}
							onLeave={panes.leaveTerminal}
							onMoveToNewTab={panes.moveToNewTab}
							moveTargetsFor={panes.moveTargetsFor}
							onMoveInto={panes.moveInto}
							onCloseFile={closeFile}
							pendingViews={pendingView}
							consumePendingView={(id) => store.getState().consumePendingView(id)}
							diffBaselines={diffBaseline}
							onUnsavedChange={(id, unsaved) =>
								store.getState().setTabUnsaved(id, unsaved)
							}
							dropTarget={drag.dropTargetIn(tab.id)}
						/>
					))
				)}

				{pickingPreview ? (
					<PreviewPicker
						onClose={() => setPickingPreview(null)}
						onOpen={(port) => {
							if (pickingPreview.replacing) {
								store.getState().closeTab(pickingPreview.replacing);
							}
							setPickingPreview(null);
							store.getState().openPreview(port);
						}}
					/>
				) : null}

				<ConfirmDialogRoot
					open={closingTab !== undefined}
					onOpenChange={(open) => {
						if (!open) setClosingTabId(null);
					}}
				>
					<ConfirmDialog
						title="Close this tab?"
						description={
							closingTab
								? closeTabWarning(
										unsavedFiles(closingTab.root),
										terminalIds(closingTab.root).length,
									)
								: ""
						}
						confirmLabel="Close tab"
						onConfirm={() => {
							if (closingTabId) panes.confirmCloseTab(closingTabId);
						}}
						onCancel={() => setClosingTabId(null)}
						returnFocusTo={panes.focusAfterCloseDialog}
					/>
				</ConfirmDialogRoot>
			</div>
			{/* The dragged pane stays put; only its title follows the pointer. */}
			<DragOverlay dropAnimation={null}>
				{draggedPane ? (
					<div className="pk-term-drag" data-testid="pane-drag-overlay">
						{draggedPane.title}
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}
