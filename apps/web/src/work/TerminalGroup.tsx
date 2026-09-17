/**
 * One tab's split tree (SPEC.md §9.3). Every split is a
 * react-resizable-panels group with a PaneHandle between siblings; the sizes
 * come from the saved layout and go back to it when the user drags a handle.
 */
import type { SplitNode, Terminal } from "@portikus/contracts";
import { PaneHandle } from "@portikus/ui";
import { Fragment, type ReactNode } from "react";
import { Group, Panel } from "react-resizable-panels";
import type { SplitDirection } from "../layout/tree.js";
import { TerminalLeaf } from "./TerminalLeaf.js";

export interface TerminalGroupProps {
	tabId: string;
	root: SplitNode;
	terminals: Map<string, Terminal>;
	workspaceId: string;
	projectId: string;
	visible: boolean;
	focusedTerminalId: string | null;
	onFocus: (terminalId: string) => void;
	onSplit: (terminalId: string, direction: SplitDirection) => void;
	onRename: (terminalId: string, name: string) => void;
	onClose: (terminalId: string) => void;
	onExited: (terminalId: string) => void;
	onReplace: (terminalId: string) => void;
	onResize: (path: number[], sizes: number[]) => void;
	onSessionEnded: () => void;
	onLeave: () => void;
}

export function TerminalGroup(props: TerminalGroupProps) {
	const { tabId, root, terminals, visible } = props;

	function panelId(path: number[], index: number): string {
		return `pk-${tabId}-${[...path, index].join("-")}`;
	}

	function render(node: SplitNode, path: number[]): ReactNode {
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
					onClose={props.onClose}
					onExited={props.onExited}
					onReplace={props.onReplace}
					onSessionEnded={props.onSessionEnded}
					onLeave={props.onLeave}
				/>
			);
		}
		const orientation = node.direction === "row" ? "horizontal" : "vertical";
		const ids = node.children.map((_, index) => panelId(path, index));
		const defaultLayout = Object.fromEntries(
			ids.map((id, index) => [id, node.sizes[index] ?? 0]),
		);
		return (
			<Group
				orientation={orientation}
				className="pk-split"
				defaultLayout={defaultLayout}
				onLayoutChanged={(layout, meta) => {
					if (!meta.isUserInteraction) return;
					props.onResize(
						path,
						ids.map((id) => layout[id] ?? 0),
					);
				}}
			>
				{node.children.map((child, index) => (
					<Fragment key={ids[index]}>
						{index > 0 ? (
							<PaneHandle
								orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
								label="Resize terminal"
							/>
						) : null}
						<Panel id={ids[index]} minSize="10%" className="pk-split-panel">
							{render(child, [...path, index])}
						</Panel>
					</Fragment>
				))}
			</Group>
		);
	}

	return (
		<div
			role="tabpanel"
			className="pk-termgroup"
			hidden={!visible}
			data-testid={`terminal-group-${tabId}`}
		>
			{render(root, [])}
		</div>
	);
}
