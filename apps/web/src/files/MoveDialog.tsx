/**
 * Move files into another folder without a drag (SPEC.md §11.2,
 * WCAG 2.5.7). The picker walks the project one folder at a time; the move
 * itself is the same file API a drag uses.
 */
import { Button, Dialog, DialogRoot, Icon } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import {
	baseName,
	canMoveInto,
	displayName,
	joinPath,
	parentOf,
	visibleEntries,
} from "./paths.js";
import { useTree } from "./queries.js";
import { ShowMoreRow } from "./ShowMoreRow.js";
import type { FileNode } from "./selection.js";

/** The folders of a listing that can be moved into, in listing order. */
function folderNames(
	entries: { name: string; type: string }[],
	showHidden: boolean,
	moving: Set<string>,
	folder: string,
): string[] {
	return visibleEntries(entries, showHidden)
		.filter(
			(entry) => entry.type === "dir" && !moving.has(joinPath(folder, entry.name)),
		)
		.map((entry) => entry.name);
}

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
		? folderNames(listing.data.entries, showHidden, moving, folder)
		: [];
	const list = useRef<HTMLUListElement | null>(null);
	// The folder to focus once the next page is drawn, so focus never drops
	// to the page when the Show more row goes.
	const [focusAfterLoad, setFocusAfterLoad] = useState<string | null>(null);
	useEffect(() => {
		if (focusAfterLoad === null) return;
		const button = list.current?.querySelector<HTMLElement>(
			`[data-folder="${CSS.escape(focusAfterLoad)}"]`,
		);
		if (!button) return;
		setFocusAfterLoad(null);
		button.focus();
	});

	async function showMore() {
		const before = folders.length;
		const result = await listing.fetchNextPage();
		if (!result.data) return;
		const after = folderNames(result.data.entries, showHidden, moving, folder);
		// The first new folder; with none and the row gone, the last one.
		const target = after[before] ?? (result.data.truncated ? undefined : after.at(-1));
		if (target !== undefined) setFocusAfterLoad(target);
	}

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
				<ul ref={list} className="m-0 max-h-64 list-none overflow-auto p-0">
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
					{folders.map((name) => {
						const path = joinPath(folder, name);
						return (
							<li key={name}>
								<button
									type="button"
									className="pk-move-folder"
									data-testid={`move-folder-${path}`}
									data-folder={name}
									onClick={() => setFolder(path)}
								>
									<Icon name="folder" size="sm" />
									{displayName(name)}
								</button>
							</li>
						);
					})}
				</ul>
				{listing.data?.truncated ? (
					// A treeitem needs a tree around it, and Enter and Space are
					// the tree's own keys, so this one-row tree answers them.
					<div
						role="tree"
						aria-label="More folders"
						className="pk-tree"
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							if (!listing.isFetchingNextPage) void showMore();
						}}
					>
						<ShowMoreRow
							path=""
							level={1}
							shown={visibleEntries(listing.data.entries, showHidden).length}
							focused
							loading={listing.isFetchingNextPage}
							onFocus={() => {}}
							onActivate={() => void showMore()}
						/>
					</div>
				) : null}
				{listing.isSuccess && !listing.data.truncated && folders.length === 0 ? (
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
