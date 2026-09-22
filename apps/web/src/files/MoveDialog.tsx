/**
 * Move files into another folder without a drag (SPEC.md §11.2, issue #370,
 * WCAG 2.5.7). The picker walks the project one folder at a time; the move
 * itself is the same file API a drag uses.
 */
import { Button, Dialog, DialogRoot, Icon } from "@portikus/ui";
import { useState } from "react";
import type { FileNode } from "./FileTree.js";
import {
	baseName,
	canMoveInto,
	displayName,
	joinPath,
	parentOf,
	visibleEntries,
} from "./paths.js";
import { useTree } from "./queries.js";

export interface MoveDialogProps {
	workspaceId: string;
	projectId: string;
	slug: string;
	nodes: FileNode[];
	showHidden: boolean;
	pending?: boolean;
	onMove: (destination: string) => void;
	onClose: () => void;
}

export function MoveDialog({
	workspaceId,
	projectId,
	slug,
	nodes,
	showHidden,
	pending,
	onMove,
	onClose,
}: MoveDialogProps) {
	const first = nodes[0];
	// Start where the first item already is, so a nearby move is one step.
	const [folder, setFolder] = useState(first ? parentOf(first.path) : "");
	const listing = useTree(workspaceId, projectId, folder);
	const moving = new Set(nodes.map((node) => node.path));
	const folders = listing.data
		? visibleEntries(listing.data.entries, showHidden).filter(
				(entry) => entry.type === "dir" && !moving.has(joinPath(folder, entry.name)),
			)
		: [];
	const allowed = nodes.every((node) => canMoveInto(node.path, folder));
	const title =
		nodes.length === 1 && first
			? `Move ${displayName(first.name)}`
			: `Move ${nodes.length} items`;

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-move-file"
				title={title}
				description="Open the folder to move into, then choose Move here."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="dialog-confirm"
							variant="primary"
							loading={pending}
							disabled={!allowed || pending}
							onClick={() => onMove(folder)}
						>
							Move here
						</Button>
					</>
				}
			>
				<p
					className="m-0 mb-2 font-mono text-sm text-ink"
					data-testid="move-destination"
				>
					~/projects/{slug}
					{folder === "" ? "" : `/${folder}`}
				</p>
				<ul className="m-0 max-h-64 list-none overflow-auto p-0">
					{folder === "" ? null : (
						<li>
							<button
								type="button"
								className="pk-move-folder"
								data-testid="move-folder-up"
								onClick={() => setFolder(parentOf(folder))}
							>
								<Icon name="chevron-up" size="sm" />
								Up to {parentOf(folder) === "" ? slug : baseName(parentOf(folder))}
							</button>
						</li>
					)}
					{folders.map((entry) => {
						const path = joinPath(folder, entry.name);
						return (
							<li key={entry.name}>
								<button
									type="button"
									className="pk-move-folder"
									data-testid={`move-folder-${path}`}
									onClick={() => setFolder(path)}
								>
									<Icon name="folder" size="sm" />
									{displayName(entry.name)}
								</button>
							</li>
						);
					})}
				</ul>
				{listing.isSuccess && folders.length === 0 ? (
					<p className="m-0 mt-2 text-sm text-ink-muted">No folders here.</p>
				) : null}
				{allowed ? null : (
					<p className="m-0 mt-2 text-sm text-ink-muted">
						{nodes.length === 1 ? "It is" : "They are"} already here, or this folder is
						inside {nodes.length === 1 ? "it" : "one of them"}.
					</p>
				)}
			</Dialog>
		</DialogRoot>
	);
}
