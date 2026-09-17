/**
 * The centre work area: the terminal tabs, their splits, and the saved
 * layout of one project (SPEC.md §7.5, §8, §9.3). Files, previews and coding
 * agents get their own tab kinds in later epics; their launcher entries are
 * here but disabled.
 */
import type { Terminal } from "@portikus/contracts";
import {
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	Menu,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
	type TabItem,
	Tabs,
} from "@portikus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLayoutPersistence } from "../layout/persist.js";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { leafIds, type SplitDirection } from "../layout/tree.js";
import { useTerminals } from "../useTerminals.js";
import { TerminalGroup } from "./TerminalGroup.js";
import "./work.css";

export interface WorkAreaProps {
	workspaceId: string;
	projectId: string;
	projectPath: string;
	onSessionEnded: () => void;
}

export function WorkArea({
	workspaceId,
	projectId,
	projectPath,
	onSessionEnded,
}: WorkAreaProps) {
	const store = useLayoutStore(projectId);
	const layout = useLayout(store, (state) => state.layout);
	const activeTabId = useLayout(store, (state) => state.activeTabId);
	const focusedTerminalId = useLayout(store, (state) => state.focusedTerminalId);
	const loaded = useLayoutPersistence(workspaceId, projectId, store, onSessionEnded);
	const terminals = useTerminals(workspaceId, projectId, true, onSessionEnded);
	const [closingTabId, setClosingTabId] = useState<string | null>(null);
	const strip = useRef<HTMLDivElement | null>(null);

	const byId = new Map(terminals.terminals.map((terminal) => [terminal.id, terminal]));

	// Once the saved layout is in, every terminal list answer decides which
	// panes exist: new terminals get a tab, gone terminals lose their pane.
	const terminalIds = terminals.terminals.map((terminal) => terminal.id).join(",");
	useEffect(() => {
		if (!loaded || !terminals.loaded) return;
		const ids = terminalIds === "" ? [] : terminalIds.split(",");
		store.getState().reconcile(ids);
	}, [loaded, terminals.loaded, terminalIds, store]);

	const newTerminal = useCallback(async (): Promise<Terminal | null> => {
		try {
			return await terminals.create();
		} catch {
			return null;
		}
	}, [terminals]);

	async function openTerminalTab() {
		const created = await newTerminal();
		if (created) store.getState().addTab(created.id);
	}

	async function split(terminalId: string, direction: SplitDirection) {
		const created = await newTerminal();
		if (created) store.getState().splitLeaf(terminalId, direction, created.id);
	}

	async function replace(terminalId: string) {
		const created = await newTerminal();
		if (created) store.getState().replaceLeaf(terminalId, created.id);
	}

	/**
	 * Delete the terminal and let the refreshed list remove the pane. The pane
	 * may stay for one round trip; a failure shows the terminals error line.
	 */
	function closeTerminal(terminalId: string) {
		void terminals.close(terminalId).catch(() => {});
	}

	function closeTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		for (const terminalId of leafIds(tab.root)) closeTerminal(terminalId);
		setClosingTabId(null);
	}

	function requestCloseTab(tabId: string) {
		const tab = layout.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const live = leafIds(tab.root).filter((id) => byId.get(id)?.endedAt == null);
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

	const items: TabItem[] = layout.tabs.map((tab) => {
		const ids = leafIds(tab.root);
		const first = ids[0] ? byId.get(ids[0]) : undefined;
		return {
			id: tab.id,
			kind: "terminal",
			label: first?.name ?? "Terminal",
			testId: `tab-${tab.id}`,
			ended: ids.length > 0 && ids.every((id) => byId.get(id)?.endedAt != null),
		};
	});

	const closingTab = layout.tabs.find((tab) => tab.id === closingTabId);

	return (
		<div className="pk-work-area" data-testid="work-area">
			<div className="pk-work-tabs" data-testid="work-tabs" ref={strip}>
				<Tabs
					tabs={items}
					activeId={activeTabId ?? ""}
					label={`Open tabs in ${projectPath}`}
					onSelect={(id) => store.getState().setActive(id)}
					onClose={requestCloseTab}
					onReorder={(from, to) => store.getState().moveTab(from, to)}
					actions={
						<MenuRoot>
							<MenuTrigger asChild={true}>
								<IconButton
									icon="plus"
									label="New"
									size="sm"
									data-testid="launcher"
									aria-haspopup="menu"
								/>
							</MenuTrigger>
							<Menu label="New tab">
								<MenuLabel>Open in {projectPath}</MenuLabel>
								<MenuItem
									icon="terminal"
									shortcut={["Mod", "Alt", "T"]}
									onSelect={() => void openTerminalTab()}
								>
									<span data-testid="launcher-terminal">Terminal</span>
								</MenuItem>
								<MenuItem icon="agent" disabled={true}>
									Claude Code — Epic 9
								</MenuItem>
								<MenuItem icon="agent" disabled={true}>
									Codex — Epic 9
								</MenuItem>
								<MenuSeparator />
								<MenuItem icon="file" disabled={true}>
									File — Epic 7
								</MenuItem>
								<MenuItem icon="preview" disabled={true}>
									Preview — Epic 8
								</MenuItem>
							</Menu>
						</MenuRoot>
					}
				/>
			</div>

			{terminals.error ? (
				<p className="pk-work-error" role="alert">
					{terminals.error}
				</p>
			) : null}

			{layout.tabs.length === 0 ? (
				<EmptyState icon="terminal" title="No terminals open">
					Use New to open a terminal in {projectPath}.
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
						onClose={closeTerminal}
						onExited={closeTerminal}
						onReplace={(id) => void replace(id)}
						onResize={(path, sizes) => store.getState().resize(tab.id, path, sizes)}
						onSessionEnded={onSessionEnded}
						onLeave={leaveTerminal}
					/>
				))
			)}

			<ConfirmDialogRoot
				open={closingTab !== undefined}
				onOpenChange={(open) => {
					if (!open) setClosingTabId(null);
				}}
			>
				<ConfirmDialog
					title="Close this tab?"
					description={`It has ${closingTab ? leafIds(closingTab.root).length : 0} terminals. Closing the tab ends them all.`}
					confirmLabel="Close tab"
					onConfirm={() => {
						if (closingTabId) closeTab(closingTabId);
					}}
					onCancel={() => setClosingTabId(null)}
				/>
			</ConfirmDialogRoot>
		</div>
	);
}
