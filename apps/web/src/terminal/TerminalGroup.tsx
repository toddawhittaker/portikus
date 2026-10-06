/**
 * One work-area tab: its split tree with a terminal, file or preview in each
 * leaf (SPEC.md §9.3).
 */
import type { SplitNode, Terminal } from "@portikus/contracts";
import { tabDomId, tabPanelDomId } from "@portikus/ui";
import type { ReactNode } from "react";
import { type LeafNode, SplitTree } from "../layout/SplitTree.js";
import type { PendingView } from "../layout/store.js";
import type { DropEdge } from "../layout/tree.js";
import { PreviewLeaf } from "../preview/PreviewLeaf.js";
import { FileLeaf } from "../work/FileLeaf.js";
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
	focusedTerminalId: string | null;
	onResize: (path: number[], sizes: number[]) => void;
	/** The other tabs a pane of this tab can join. */
	moveTargetsFor: (terminalId: string) => { tabId: string; label: string }[];
	/** Close this whole tab: a file tab offers it when the file is gone. */
	onCloseTab: () => void;
	/** What this file tab was last asked to show, or undefined for nothing. */
	pendingView: PendingView | undefined;
	/** Read and forget that request. */
	consumePendingView: () => PendingView | undefined;
	/** Bring the Running surface into view (BROWSER-HANDLING.md §12). */
	onShowRunning: () => void;
	/** Pick another port in place of this preview tab's refused one. */
	onChoosePreviewPort: () => void;
	/** A file tab reporting whether its edits are on disk. */
	onUnsavedChange?: (unsaved: boolean) => void;
	/** Object id this file tab's diff compares against, or null for Git HEAD. */
	diffBaseline?: string | null;
	/** The pane a drag is hovering, and the zone it would drop into. */
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
			return (
				<FileLeaf
					key={node.path}
					path={node.path}
					workspaceId={props.workspaceId}
					projectId={props.projectId}
					visible={visible}
					onClose={props.onCloseTab}
					pendingView={props.pendingView}
					consumePendingView={props.consumePendingView}
					onUnsavedChange={props.onUnsavedChange}
					baseline={props.diffBaseline}
				/>
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
