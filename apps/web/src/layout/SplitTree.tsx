/**
 * One tab's split tree (SPEC.md §9.3). Every split is a
 * react-resizable-panels group with a PaneHandle between siblings; the sizes
 * come from the saved layout and go back to it when the user drags a handle.
 * What sits in each leaf is the caller's.
 */
import type { SplitNode } from "@portikus/contracts";
import { PaneHandle } from "@portikus/ui";
import { Fragment, type ReactNode, useRef } from "react";
import { Group, type GroupImperativeHandle, Panel } from "react-resizable-panels";
import { evenSizes } from "./tree.js";

/** Any node that is not a split. */
export type LeafNode = Exclude<SplitNode, { type: "split" }>;

export interface SplitTreeProps {
	/** Makes the panel ids unique across tabs. */
	tabId: string;
	root: SplitNode;
	onResize: (path: number[], sizes: number[]) => void;
	/** `resetSizes` shares the tab's space out evenly again, and saves it. */
	renderLeaf: (node: LeafNode, tools: { resetSizes: () => void }) => ReactNode;
}

export function SplitTree({ tabId, root, onResize, renderLeaf }: SplitTreeProps) {
	// Each split's handle, by its path, so a reset can resize it in place
	// without remounting the panes inside.
	const groups = useRef(new Map<string, GroupImperativeHandle>());

	function panelId(path: number[], index: number): string {
		return `pk-${tabId}-${[...path, index].join("-")}`;
	}

	function resetSizes() {
		function walk(node: SplitNode, path: number[]) {
			if (node.type !== "split") return;
			const sizes = evenSizes(node.children.length);
			groups.current
				.get(path.join("-"))
				?.setLayout(
					Object.fromEntries(
						node.children.map((_, index) => [panelId(path, index), sizes[index] ?? 0]),
					),
				);
			onResize(path, sizes);
			node.children.forEach((child, index) => {
				walk(child, [...path, index]);
			});
		}
		walk(root, []);
	}

	function render(node: SplitNode, path: number[]): ReactNode {
		if (node.type !== "split") return renderLeaf(node, { resetSizes });
		const orientation = node.direction === "row" ? "horizontal" : "vertical";
		const ids = node.children.map((_, index) => panelId(path, index));
		const defaultLayout = Object.fromEntries(
			ids.map((id, index) => [id, node.sizes[index] ?? 0]),
		);
		return (
			<Group
				orientation={orientation}
				className="pk-split"
				// So a test can see which way a split runs.
				data-direction={node.direction}
				defaultLayout={defaultLayout}
				groupRef={(handle) => {
					if (handle) groups.current.set(path.join("-"), handle);
					else groups.current.delete(path.join("-"));
				}}
				onLayoutChanged={(layout, meta) => {
					if (!meta.isUserInteraction) return;
					onResize(
						path,
						ids.map((id) => layout[id] ?? 0),
					);
				}}
			>
				{node.children.map((child, index) => (
					// Keyed by the terminal, not the position, so swapping two panes
					// moves them instead of remounting both terminals.
					<Fragment key={child.type === "leaf" ? child.terminalId : ids[index]}>
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

	return <>{render(root, [])}</>;
}
