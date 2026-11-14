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
import { requestToolReveal } from "../chat/revealTool.js";
import { useCourseProfile } from "../editor/settingsQueries.js";
import { baseName, displayName } from "../files/paths.js";
import { useLayoutPersistence } from "../layout/persist.js";
import { useRemoteFocusFallback } from "../layout/remoteFocus.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import {
	filePaths,
	fileTabId,
	type SplitDirection,
	tabOfPane,
	terminalIds,
} from "../layout/tree.js";
import { PreviewPicker } from "../preview/PreviewPicker.js";
import { useShowRightPane } from "../shell/rightPane.js";
import { agentLabel } from "../terminal/agentLabel.js";
import {
	marksByTerminal,
	mostUrgent,
	useAgentStatus,
	useAgentStatusStore,
} from "../terminal/codingAgentStatus.js";
import { TerminalGroup } from "../terminal/TerminalGroup.js";
import { type Terminals, useTerminals } from "../terminal/useTerminals.js";
import { type Launch, LauncherItems, launchInit } from "./LauncherItems.js";
import { dropTreeFiles, type MoveIntoTarget } from "./moveInto.js";
import { usePointerDismiss } from "./pointerDismiss.js";
import { TreeFileDrop } from "./TreeFileDrop.js";
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
	/** A terminal whose tab the URL asked to select, from the project list (SPEC.md §8.2). */
	selectTerminalId?: string;
	/** In that terminal's chat, the tool row to show. */
	revealToolId?: string;
	/** The selection above is done; the route clears it from the URL. */
	onSelectedFromUrl?: () => void;
}

/**
 * A terminal tab's label and hover text: a chat's conversation title once it
 * has one (ADR 0074), else the agent's name or the terminal's.
 */
export function terminalTabText(
	terminal: Terminal | undefined,
	named: string | null,
	chatTitles: ReadonlyMap<string, string>,
): { label: string; title?: string } {
	const label = named ?? terminal?.name ?? "Terminal";
	const chatTitle = terminal?.kind === "chat" ? chatTitles.get(terminal.id) : undefined;
	return chatTitle ? { label: chatTitle, title: `${label}: ${chatTitle}` } : { label };
}

export function WorkArea({
	workspaceId,
	projectId,
	projectPath,
	openPath,
	openLine,
	openPreviewPort,
	selectTerminalId,
	revealToolId,
	onSelectedFromUrl,
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
	// Traditional hides the agent launchers only; nothing is blocked (SPEC.md §8.7).
	const traditional = useCourseProfile() === "traditional";
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
	const area = useRef<HTMLDivElement | null>(null);
	const remoteFocusNote = useRemoteFocusFallback(store, area);
	// Where a file dragged from the tree would land (SPEC.md §9.3).
	const [treeTarget, setTreeTarget] = useState<MoveIntoTarget | null>(null);

	/** Open a file dragged from the tree beside a pane, or move its open pane there. */
	function dropTargetIn(tabId: string) {
		const fromPane = drag.dropTargetIn(tabId);
		if (fromPane) return fromPane;
		return treeTarget?.tabId === tabId
			? { paneId: treeTarget.paneId, edge: treeTarget.edge }
			: null;
	}
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

	const onSelectedFromUrlRef = useRef(onSelectedFromUrl);
	onSelectedFromUrlRef.current = onSelectedFromUrl;
	// A tab the URL named is selected once both lists are in, after the
	// reconcile above has given every terminal its pane. The parameters are
	// then cleared, so following the same link again selects the tab again.
	const terminalKinds = new Map(terminals.terminals.map((one) => [one.id, one.kind]));
	const selectKind = selectTerminalId ? terminalKinds.get(selectTerminalId) : undefined;
	useEffect(() => {
		if (!selectTerminalId || !loaded || !terminals.loaded) return;
		const tabId = tabOfPane(store.getState().layout, selectTerminalId);
		if (tabId) {
			store.getState().setActive(tabId);
			store.getState().setFocused(selectTerminalId);
			if (revealToolId && selectKind === "chat") {
				requestToolReveal(selectTerminalId, revealToolId);
			}
		}
		onSelectedFromUrlRef.current?.();
	}, [selectTerminalId, revealToolId, selectKind, loaded, terminals.loaded, store]);

	// Place the new terminal before the list is refetched, so no reconcile ever
	// sees a terminal that has no pane yet and gives it a tab of its own.
	async function createAndPlace(
		place: (created: Terminal) => void,
		init?: Parameters<Terminals["create"]>[0],
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

	async function openTab(launch: Launch) {
		await createAndPlace(placeFocusedTab, launchInit(launch));
	}

	/** The new pane takes the keyboard; a chat's composer then focuses itself. */
	async function split(terminalId: string, direction: SplitDirection, launch: Launch) {
		await createAndPlace((created) => {
			store.getState().splitLeaf(terminalId, direction, created.id);
			store.getState().setFocused(created.id);
		}, launchInit(launch));
	}

	/**
	 * An ended chat goes on in a new chat of the same agent in its place; the
	 * ended record is then closed, as the new one carries its session (SPEC.md §10.8).
	 */
	async function resume(terminalId: string) {
		await createAndPlace(
			(created) => {
				store.getState().replaceLeaf(terminalId, created.id);
				store.getState().setFocused(created.id);
				closeTerminal(terminalId);
			},
			{ kind: "chat", agent: chatAgentOf(terminalId), resumeChatOf: terminalId },
		);
	}

	/** A fresh chat in an ended chat's place; the ended record stays in the history. */
	async function newChat(terminalId: string) {
		await createAndPlace(
			(created) => {
				store.getState().replaceLeaf(terminalId, created.id);
				store.getState().setFocused(created.id);
			},
			{ kind: "chat", agent: chatAgentOf(terminalId) },
		);
	}

	/** The agent an ended chat ran, which its resume or new chat runs too. */
	function chatAgentOf(terminalId: string): CodingAgent {
		return byId.get(terminalId)?.agent === "codex" ? "codex" : "claude";
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

	const agentSnapshot = useAgentStatus();
	const agentMarks = marksByTerminal(agentSnapshot);
	// A chat's tab shows its conversation title once it has one (ADR 0074).
	const chatTitles = new Map(
		agentSnapshot.terminals.flatMap((item) =>
			item.title ? [[item.terminalId, item.title] as const] : [],
		),
	);
	const agentStatus = useAgentStatusStore();
	// The terminals in the tab on screen are the ones the student is looking at.
	const activeTab = layout.tabs.find((tab) => tab.id === activeTabId);
	const viewingKey = activeTab ? terminalIds(activeTab.root).join(",") : "";
	useEffect(() => {
		if (!agentStatus) return;
		agentStatus.setViewing(viewingKey === "" ? [] : viewingKey.split(","));
		return () => agentStatus.setViewing([]);
	}, [agentStatus, viewingKey]);

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
		// A split tab is named for its focused pane, so a tab never names one
		// pane while the keyboard is in another; otherwise for its first pane.
		const shownId =
			focusedPaneId !== null && ids.includes(focusedPaneId) ? focusedPaneId : ids[0];
		const first = shownId ? byId.get(shownId) : undefined;
		// Claude Code and Codex share the agent icon and are named apart from a
		// shell (design system, Iconography). The terminal record is the source.
		const agent =
			first?.agent === "claude" || first?.agent === "codex" ? first.agent : null;
		const named = first ? agentLabel(first) : null;
		// A split tab shows its most urgent pane.
		const mark = mostUrgent(
			ids.flatMap((id) => {
				const found = agentMarks.get(id);
				return found ? [found] : [];
			}),
		);
		return {
			id: tab.id,
			kind: agent ?? "terminal",
			agentState: mark?.state,
			unread: mark?.unread,
			...terminalTabText(first, named, chatTitles),
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
			<TreeFileDrop
				area={area}
				layout={layout}
				onTarget={setTreeTarget}
				onDrop={(paths, target) => dropTreeFiles(store.getState, paths, target)}
			/>
			<div className="pk-work-area" data-testid="work-area" ref={area}>
				{/* Always mounted, so the move of focus is announced (SPEC.md §25.8). */}
				<p
					role="status"
					aria-live="polite"
					className="sr-only"
					data-testid="layout-announce"
				>
					{remoteFocusNote}
				</p>
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
									<LauncherItems
										testIdPrefix="launcher"
										traditional={traditional}
										terminalShortcut={["Mod", "Alt", "T"]}
										onLaunch={(launch) => {
											launcherMenu.declineTriggerFocus();
											void openTab(launch);
										}}
									/>
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
								{traditional ? null : (
									<Button
										variant="secondary"
										iconStart="agent"
										data-testid="empty-open-claude"
										onClick={() => void openTab({ kind: "agent", agent: "claude" })}
									>
										Start Claude Code
									</Button>
								)}
							</>
						}
					>
						{traditional
							? "Open a terminal. The + in the tab bar also opens previews."
							: "Open a terminal or start Claude Code. The + in the tab bar also opens Codex and previews."}
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
							splitItems={(id, direction) => (
								<LauncherItems
									testIdPrefix={`split-${direction === "row" ? "right" : "down"}`}
									traditional={traditional}
									onLaunch={(launch) => void split(id, direction, launch)}
								/>
							)}
							onRename={(id, name) => void terminals.rename(id, name)}
							onSetTheme={(id, theme) => void terminals.setTheme(id, theme)}
							onClose={closePane}
							onExited={terminalExited}
							onReplace={(id) => void replace(id)}
							onResume={(id) => void resume(id)}
							onNewChat={(id) => void newChat(id)}
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
							dropTarget={dropTargetIn(tab.id)}
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
