/**
 * One work-area tab: its split tree with a terminal, file or preview in each
 * leaf (SPEC.md §9.3).
 */
import type { SplitNode, Terminal } from "@portikus/contracts";
import { tabDomId, tabPanelDomId } from "@portikus/ui";
import type { ReactNode } from "react";
import { type LeafNode, SplitTree } from "../layout/SplitTree.js";
import type { PendingView } from "../layout/store.js";
import { type DropEdge, fileTabId } from "../layout/tree.js";
import { PreviewLeaf } from "../preview/PreviewLeaf.js";
import { FileLeaf } from "../work/FileLeaf.js";
import { FilePane } from "../work/FilePane.js";
import { TerminalLeaf, type TerminalLeafProps } from "./TerminalLeaf.js";

/** The pane callbacks a group hands down to each terminal unchanged. */
type PaneCallbacks = Pick<
	TerminalLeafProps,
	| "onFocus"
	| "onSplit"
	| "onRename"
	| "onSetTheme"
	| "onClose"
	| "onExited"
	| "onReplace"
	| "onLeave"
	| "onMoveToNewTab"
	| "onMoveInto"
>;

export interface TerminalGroupProps extends PaneCallbacks {
	tabId: string;
	root: SplitNode;
	terminals: Map<string, Terminal>;
	workspaceId: string;
	projectId: string;
	visible: boolean;
	/** The pane the keyboard is in: a terminal id, or a file's pane id. */
	focusedTerminalId: string | null;
	onResize: (path: number[], sizes: number[]) => void;
	/** The other tabs a pane of this tab can join, by pane id. */
	moveTargetsFor: (paneId: string) => { tabId: string; label: string }[];
	/** Close one file's pane: from its menu, or when the file is gone. */
	onCloseFile: (path: string) => void;
	/** What each file pane was last asked to show, by pane id. */
	pendingViews: Record<string, PendingView>;
	/** Read and forget the request for one file pane. */
	consumePendingView: (paneId: string) => PendingView | undefined;
	/** Bring the Running surface into view (BROWSER-HANDLING.md §12). */
	onShowRunning: () => void;
	/** Pick another port in place of this preview tab's refused one. */
	onChoosePreviewPort: () => void;
	/** A file pane, by pane id, reporting whether its edits are on disk. */
	onUnsavedChange: (paneId: string, unsaved: boolean) => void;
	/** Object id each file pane's diff compares against, by pane id; none means Git HEAD. */
	diffBaselines: Record<string, string | null>;
	/** The pane a drag is hovering, by pane id, and the zone it would drop into. */
	dropTarget?: { terminalId: string; edge: DropEdge } | null;
}

export function TerminalGroup(props: TerminalGroupProps) {
	const { tabId, root, terminals, visible } = props;

	function renderLeaf(
		node: LeafNode,
		{ resetSizes }: { resetSizes: () => void },
	): ReactNode {
		if (node.type === "leaf") {
			const terminal = terminals.get(node.terminalId);
			if (!terminal) return null;
			return (
				<TerminalLeaf
					key={terminal.id}
					workspaceId={props.workspaceId}
					projectId={props.projectId}
					terminal={terminal}
					visible={visible}
					focused={props.focusedTerminalId === terminal.id}
					onFocus={props.onFocus}
					onSplit={props.onSplit}
					onRename={props.onRename}
					onSetTheme={props.onSetTheme}
					onClose={props.onClose}
					onExited={props.onExited}
					onReplace={props.onReplace}
					onLeave={props.onLeave}
					onMoveToNewTab={props.onMoveToNewTab}
					moveTargets={props.moveTargetsFor(terminal.id)}
					onMoveInto={props.onMoveInto}
					onResetSizes={resetSizes}
					alone={root.type === "leaf"}
					dropEdge={
						props.dropTarget?.terminalId === terminal.id ? props.dropTarget.edge : null
					}
				/>
			);
		}
		// A diff is a view of the file's tab, not a tab of its own;
		// a layout saved before that still names one, and it opens as
		// the file it shows.
		if (node.type === "file" || node.type === "diff") {
			const path = node.path;
			const id = fileTabId(path);
			return (
				<FilePane
					key={path}
					path={path}
					alone={root.type !== "split"}
					focused={props.focusedTerminalId === id}
					dropEdge={props.dropTarget?.terminalId === id ? props.dropTarget.edge : null}
					moveTargets={props.moveTargetsFor(id)}
					onFocus={props.onFocus}
					onMoveToNewTab={props.onMoveToNewTab}
					onMoveInto={props.onMoveInto}
					onResetSizes={resetSizes}
					onClose={props.onCloseFile}
				>
					<FileLeaf
						path={path}
						workspaceId={props.workspaceId}
						projectId={props.projectId}
						visible={visible}
						onClose={() => props.onCloseFile(path)}
						pendingView={props.pendingViews[id]}
						consumePendingView={() => props.consumePendingView(id)}
						onUnsavedChange={(unsaved) => props.onUnsavedChange(id, unsaved)}
						baseline={props.diffBaselines[id] ?? null}
					/>
				</FilePane>
			);
		}
		return (
			<PreviewLeaf
				key={node.port}
				workspaceId={props.workspaceId}
				port={node.port}
				visible={visible}
				onShowRunning={props.onShowRunning}
				onChoosePort={props.onChoosePreviewPort}
			/>
		);
	}

	return (
		<div
			role="tabpanel"
			id={tabPanelDomId(tabId)}
			aria-labelledby={tabDomId(tabId)}
			className="pk-termgroup"
			hidden={!visible}
			data-testid={`terminal-group-${tabId}`}
		>
			<SplitTree
				tabId={tabId}
				root={root}
				onResize={props.onResize}
				renderLeaf={renderLeaf}
			/>
		</div>
	);
}
