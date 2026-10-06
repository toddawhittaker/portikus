/**
 * The centre work area: the terminal tabs, their splits, and the saved
 * layout of one project (SPEC.md §7.5, §8, §9.3, §10.2). A coding-agent
 * launcher creates an ordinary terminal and names the agent.
 */
import { DndContext, DragOverlay, pointerWithin, useDroppable } from "@dnd-kit/core";
import type { CodingAgent, Terminal } from "@portikus/contracts";
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
	tabDomId,
} from "@portikus/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLayoutPersistence } from "../layout/persist.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { type SplitDirection, terminalIds } from "../layout/tree.js";
import { PreviewPicker } from "../preview/PreviewPicker.js";
import { useShowRightPane } from "../shell/rightPane.js";
import { TerminalGroup } from "../terminal/TerminalGroup.js";
import { useTerminals } from "../terminal/useTerminals.js";
import { moveIntoTargets } from "./moveInto.js";
import { focusAfterPane, tabAfterClose } from "./paneFocus.js";
import { usePointerDismiss } from "./pointerDismiss.js";
import { TAB_STRIP_DROP_ID, usePaneDrag } from "./usePaneDrag.js";
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

/** The tab strip as a drop area; separate so it can use `useDroppable`. */
function TabStripDrop({ children }: { children: ReactNode }) {
	const drop = useDroppable({ id: TAB_STRIP_DROP_ID });
	return (
		<div className="pk-work-tabs-drop" ref={drop.setNodeRef}>
			{children}
		</div>
	);
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
	const focusedTerminalId = useLayout(store, (state) => state.focusedTerminalId);
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

	/** Move the keyboard to the next pane in the tab, or to the New control (SPEC.md §25.8). */
	function moveFocusOff(terminalId: string) {
		const next = focusAfterPane(layout, terminalId, launcher());
		if (next) store.getState().setFocused(next);
	}

	/** Close from the pane's menu: the keyboard moves on rather than being lost. */
	function closePane(terminalId: string) {
		moveFocusOff(terminalId);
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

	// The tab a confirmed tab close leaves active, for the dialog to return
	// focus to; undefined until confirmed, so Cancel returns focus as usual.
	const tabAfterConfirm = useRef<string | null | undefined>(undefined);

	function confirmCloseTab(tabId: string) {
		const next = tabAfterClose(layout, tabId, store.getState().tabHistory);
		tabAfterConfirm.current = next;
		// The terminals go one round trip later; show the next tab now.
		if (next) store.getState().setActive(next);
		closeTab(tabId);
	}

	function focusAfterCloseDialog(): HTMLElement | null {
		const next = tabAfterConfirm.current;
		tabAfterConfirm.current = undefined;
		if (next === undefined) return null;
		return next ? document.getElementById(tabDomId(next)) : launcher();
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
		for (const terminalId of terminalIds(tab.root)) closeTerminal(terminalId);
		setClosingTabId(null);
	}

	function requestCloseTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const live = terminalIds(tab.root).filter((id) => byId.get(id)?.endedAt == null);
		if (live.length > 1) {
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

	/** Alt+Shift+Q leaves the terminal for the tab strip (DESIGN.md). */
	function leaveTerminal() {
		const tabs = strip.current?.querySelectorAll<HTMLElement>('[role="tab"]');
		if (!tabs) return;
		const index = layout.tabs.findIndex((tab) => tab.id === activeTabId);
		(tabs[index < 0 ? 0 : index] ?? tabs[0])?.focus();
	}

	/** Give a pane a tab of its own after its current one. */
	function moveToNewTab(terminalId: string) {
		const from = layout.tabs.findIndex((tab) =>
			terminalIds(tab.root).includes(terminalId),
		);
		store.getState().moveLeafToNewTab(terminalId, from + 1);
		store.getState().setFocused(terminalId);
	}

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
		if (tab.root.type === "file" || tab.root.type === "diff") {
			const path = tab.root.path;
			return {
				id: tab.id,
				kind: tab.root.type,
				// The strip has no room for a path, so the file name is the label.
				label: path.split("/").pop() ?? path,
				title: path,
				dirty: unsavedTabs[tab.id] ?? false,
				testId: `tab-${tab.id}`,
			};
		}
		const ids = terminalIds(tab.root);
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
		};
	});

	/** The other tabs a pane can join, under the names the tab strip shows. */
	function moveTargetsFor(terminalId: string) {
		return moveIntoTargets(layout, terminalId).map((target) => ({
			tabId: target.tabId,
			label: items.find((item) => item.id === target.tabId)?.label ?? "Tab",
		}));
	}

	/** Put a pane into another tab's split, as dropping it there would. */
	function moveInto(terminalId: string, tabId: string) {
		const target = moveIntoTargets(layout, terminalId).find(
			(candidate) => candidate.tabId === tabId,
		);
		if (!target) return;
		store.getState().moveLeaf(tabId, terminalId, target.terminalId, target.edge);
		store.getState().setFocused(terminalId);
	}

	const closingTab = layout.tabs.find((tab) => tab.id === closingTabId);

	return (
		<DndContext
			sensors={drag.sensors}
			collisionDetection={pointerWithin}
			{...drag.handlers}
		>
			<div className="pk-work-area" data-testid="work-area">
				<TabStripDrop>
					<div className="pk-work-tabs" data-testid="work-tabs" ref={strip}>
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
									<Menu
										label="New tab"
										onCloseAutoFocus={launcherMenu.onCloseAutoFocus}
									>
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
						{dragTarget?.kind === "strip" ? (
							<div
								className="pk-tab-insert"
								data-testid="tab-insert-marker"
								data-index={dragTarget.index}
								style={{ left: `${dragTarget.markerX}px` }}
							/>
						) : null}
					</div>
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
							focusedTerminalId={focusedTerminalId}
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
							onLeave={leaveTerminal}
							onMoveToNewTab={moveToNewTab}
							moveTargetsFor={moveTargetsFor}
							onMoveInto={moveInto}
							onCloseTab={() => store.getState().closeTab(tab.id)}
							pendingView={pendingView[tab.id]}
							consumePendingView={() => store.getState().consumePendingView(tab.id)}
							diffBaseline={diffBaseline[tab.id] ?? null}
							onUnsavedChange={(unsaved) =>
								store.getState().setTabUnsaved(tab.id, unsaved)
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
						description={`It has ${closingTab ? terminalIds(closingTab.root).length : 0} terminals. Closing the tab ends them all.`}
						confirmLabel="Close tab"
						onConfirm={() => {
							if (closingTabId) confirmCloseTab(closingTabId);
						}}
						onCancel={() => setClosingTabId(null)}
						returnFocusTo={focusAfterCloseDialog}
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
