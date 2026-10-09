/**
 * The rows of the files pane: the tree, its directories and rows, their
 * menus, and the drop targets for the project root (SPEC.md §11.2, §25.8).
 */

import type { Project, TreeEntry } from "@portikus/contracts";
import {
	Button,
	ContextMenu,
	ContextMenuTrigger,
	EmptyState,
	Icon,
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
} from "@portikus/ui";
import { memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { fileIconName } from "./fileIcon.js";
import { type GitDecoration, isIgnored } from "./gitStatus.js";
import {
	displayName,
	entryCount,
	joinPath,
	parentOf,
	showMorePath,
	visibleEntries,
} from "./paths.js";
import { useTree } from "./queries.js";
import { useRowState } from "./rowState.js";
import { ShowMoreRow } from "./ShowMoreRow.js";
import type { FileNode } from "./selection.js";
import { useTreeApi } from "./treeApi.js";
import { useTreeKeys } from "./treeKeys.js";

/** What the tree area shows: an error, an empty project, or the tree itself. */
export function TreeListing({
	project,
	failed,
	allHidden,
	empty,
	onRetry,
	onNewFile,
}: {
	project: Project;
	failed: boolean;
	allHidden: boolean;
	empty: boolean;
	onRetry: () => void;
	onNewFile: () => void;
}) {
	if (failed) {
		return (
			<EmptyState
				icon="alert"
				title="The files could not be listed"
				actions={
					<Button size="sm" data-testid="file-tree-retry" onClick={onRetry}>
						Retry
					</Button>
				}
			>
				The workspace did not answer. Try again in a moment.
			</EmptyState>
		);
	}
	if (allHidden) {
		return (
			<EmptyState icon="file" title="Nothing to show">
				Everything here is hidden. Turn on Show hidden files to see it.
			</EmptyState>
		);
	}
	if (empty) {
		return (
			<EmptyState
				icon="file"
				title="No files yet"
				actions={
					<Button size="sm" data-testid="files-empty-new-file" onClick={onNewFile}>
						New file
					</Button>
				}
			>
				Create a file, upload one, or use a terminal.
			</EmptyState>
		);
	}
	return (
		<>
			<TreeRoot slug={project.slug} />
			<RootSpaceDropZone name={project.name} />
		</>
	);
}
/** Whether a row is being dragged over the project root. */
function useMoveOverRoot(): boolean {
	const { rowState } = useTreeApi();
	return useStore(
		rowState,
		(state) => state.draggedPath !== null && state.dropDir === "",
	);
}

/**
 * The empty area below the last row. Dropping a file here moves it to the
 * project root, which is otherwise only reachable through the path line
 * (SPEC.md §11.2).
 */
function RootSpaceDropZone({ name }: { name: string }) {
	const over = useMoveOverRoot();
	return (
		<div
			className={`pk-tree-space${over ? " is-drop-target" : ""}`}
			data-drop-dir=""
			data-testid="file-tree-space-drop"
			data-drop-over={over ? "true" : undefined}
		>
			{over ? <span>Move to {name}</span> : null}
		</div>
	);
}

/** The path line under the header, and the drop target for the project root. */
export function RootDropZone({ slug }: { slug: string }) {
	const over = useMoveOverRoot();
	return (
		<div
			className="pk-pane-sub"
			data-drop-dir=""
			data-testid="file-tree-root-drop"
			data-drop-over={over ? "true" : undefined}
		>
			~/projects/{slug}
		</div>
	);
}

/** The tree itself: the root listing plus whatever is expanded under it. */
function TreeRoot({ slug }: { slug: string }) {
	const api = useTreeApi();
	const ref = useRef<HTMLDivElement | null>(null);
	const helpId = useId();
	const { treeRef } = api;
	useEffect(() => {
		treeRef(ref.current);
		return () => treeRef(null);
	}, [treeRef]);

	// Moving the focus renders only the rows (rowState.ts); subscribing here
	// re-runs the check below whenever it moves, even to a row not on screen.
	useStore(api.rowState, (state) => state.focusedPath);
	const { repairFocus } = api;
	useEffect(() => repairFocus());

	const onKeyDown = useTreeKeys(api);

	return (
		// The ARIA tree pattern on plain elements: the roles carry the meaning.
		<div
			ref={ref}
			role="tree"
			aria-multiselectable="true"
			aria-label={`Files in ${slug}`}
			aria-describedby={helpId}
			className="pk-tree"
			data-testid="file-tree"
			onKeyDown={onKeyDown}
			onFocus={api.treeFocusHandlers.onFocus}
			onBlur={api.treeFocusHandlers.onBlur}
		>
			<span id={helpId} className="pk-visually-hidden">
				Arrow keys move and open folders, Home and End go to the first and last row, and
				typing a name jumps to it. Shift with an arrow extends the selection, Ctrl+Space
				adds or removes a row. Enter opens a file, Shift+F10 or the Menu key opens the
				actions for a row, Delete deletes it.
			</span>
			<Directory dir="" level={1} />
		</div>
	);
}

/** One directory's rows. Mounted only while the directory is open. */
function Directory({ dir, level }: { dir: string; level: number }) {
	const api = useTreeApi();
	const query = useTree(api.workspaceId, api.projectId, dir);
	// Both agents return directories first, then files, each in name order.
	const entries = query.data ? visibleEntries(query.data.entries, api.showHidden) : [];
	const morePath = showMorePath(dir);
	const moreFocused = useRowState(api.rowState, morePath).focused;
	// The row to focus once the next page is drawn, so focus never drops to the page.
	const [focusAfterLoad, setFocusAfterLoad] = useState<string | null>(null);
	const { rowElements, setFocusedPath, announce, showHidden, repairFocus } = api;

	// A refetch can drop the focused row while rendering only this directory.
	useEffect(() => {
		if (query.data) repairFocus();
	}, [query.data, repairFocus]);

	useEffect(() => {
		if (focusAfterLoad === null) return;
		const row = rowElements().find(
			(element) => element.getAttribute("data-path") === focusAfterLoad,
		);
		if (!row) return;
		setFocusAfterLoad(null);
		setFocusedPath(focusAfterLoad);
		row.focus();
	});

	async function showMore() {
		const before = entries.length;
		const result = await query.fetchNextPage();
		if (!result.data) return;
		const after = visibleEntries(result.data.entries, showHidden);
		const added = after.length - before;
		announce(
			result.data.truncated
				? `Loaded ${added.toLocaleString("en")} more ${added === 1 ? "entry" : "entries"}`
				: `All ${entryCount(after.length)} shown`,
		);
		// The first new row; with none visible and the Show more row gone, the last row.
		const target =
			added > 0 ? after[before] : result.data.truncated ? null : after.at(-1);
		if (target) setFocusAfterLoad(joinPath(dir, target.name));
	}

	return (
		<>
			{entries.map((entry) => (
				<Row key={entry.name} dir={dir} entry={entry} level={level} />
			))}
			{query.data?.truncated ? (
				<ShowMoreRow
					path={morePath}
					level={level}
					shown={entries.length}
					focused={moreFocused}
					loading={query.isFetchingNextPage}
					onFocus={() => setFocusedPath(morePath)}
					onActivate={() => void showMore()}
				/>
			) : null}
		</>
	);
}

/** What a row's Git letter, dot and muted colour say, in words. */
function rowStatus(
	decoration: GitDecoration | undefined,
	dirty: boolean,
	ignored: boolean,
): string | null {
	if (decoration) return decoration.title;
	if (dirty) return "contains changes";
	if (ignored) return "ignored";
	return null;
}

/** A row's twisty, icon, name and Git marks, inside the right-click trigger's span. */
function RowFace({
	name,
	shown,
	isDir,
	open,
	status,
	decoration,
	dirty,
	ignored,
}: {
	name: string;
	shown: string;
	isDir: boolean;
	open: boolean;
	status: string | null;
	decoration: GitDecoration | undefined;
	dirty: boolean;
	ignored: boolean;
}) {
	const folderIcon = open ? "folder-open" : "folder";
	return (
		<>
			<span className="pk-tree-twisty">
				{isDir ? (
					<Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
				) : null}
			</span>
			<Icon name={isDir ? folderIcon : fileIconName(name)} size="md" />
			<span className="pk-tree-name">{shown}</span>
			{status ? <span className="pk-visually-hidden">, {status}</span> : null}
			{ignored && !decoration && !dirty ? (
				<span className="pk-tree-tag" aria-hidden="true">
					ignored
				</span>
			) : null}
			{decoration ? (
				<>
					{decoration.kind === "conflict" ? <Icon name="alert" size="sm" /> : null}
					<span className="pk-git-letter" aria-hidden="true">
						{decoration.letter}
					</span>
				</>
			) : dirty ? (
				<span className="pk-git-dot" aria-hidden="true" />
			) : null}
		</>
	);
}

// Memoised, so a render of the pane or a directory does not redraw thousands of rows.
const Row = memo(function Row({
	dir,
	entry,
	level,
}: {
	dir: string;
	entry: TreeEntry;
	level: number;
}) {
	const api = useTreeApi();
	const path = joinPath(dir, entry.name);
	const isDir = entry.type === "dir";
	const node: FileNode = { path, name: entry.name, isDir };
	const open = isDir && api.expanded.includes(path);
	// A name is drawn without the characters that could disguise it.
	const shown = displayName(entry.name);
	// Git state: the file's own letter, or a dot when a directory holds a
	// change (SPEC.md §12.1).
	const decoration = api.git.byPath.get(path);
	const dirty = isDir && api.git.changedDirs.has(path);
	const ignored = api.git.repo && isIgnored(path, api.git.ignored);
	const title = decoration ? `${shown} — ${decoration.title}` : undefined;
	// What the letter, the dot and the muted colour say, in words.
	const status = rowStatus(decoration, dirty, ignored);
	const rowRef = useRef<HTMLDivElement | null>(null);

	const { focused, selected, current, dragging, dropTarget } = useRowState(
		api.rowState,
		path,
	);
	const over = isDir && dropTarget;

	function activate() {
		api.setFocusedPath(path);
		if (isDir) api.toggle(path);
		else api.openFile(node);
	}

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles keys for every row
		<div
			ref={rowRef}
			role="treeitem"
			aria-level={level}
			aria-expanded={isDir ? open : undefined}
			aria-selected={selected}
			data-selected={selected ? "true" : undefined}
			data-current={current ? "true" : undefined}
			tabIndex={focused ? 0 : -1}
			data-path={path}
			data-kind={isDir ? "dir" : "file"}
			data-testid={`file-row-${path}`}
			data-git={decoration?.kind ?? (dirty ? "dir" : undefined)}
			data-ignored={ignored ? "true" : undefined}
			className="pk-tree-item"
			onFocus={(event) => {
				// Rows nest, so a child row's focus bubbles here too.
				if (event.target === event.currentTarget) api.setFocusedPath(path);
			}}
			onContextMenu={(event) => {
				// A keyboard context menu lands on the focused row itself; a pointer
				// lands inside it and is handled by the right-click menu.
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				api.setMenuPath(path);
			}}
			onClick={(event) => {
				// A click inside a nested row belongs to that row, not this one.
				const row =
					event.target instanceof Element
						? event.target.closest("[role=treeitem]")
						: null;
				if (row !== event.currentTarget) return;
				const modifiers = {
					toggle: event.ctrlKey || event.metaKey,
					range: event.shiftKey,
				};
				api.clickRow(path, modifiers);
				// Holding a modifier is about the selection, not about opening.
				if (modifiers.toggle || modifiers.range) {
					api.setFocusedPath(path);
					return;
				}
				activate();
			}}
		>
			{/* The browser draws the dragged row under the pointer. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer drag source; Move to is the keyboard way */}
			<div
				draggable
				onDragStart={(event) => api.startMove(event, node)}
				onDragEnd={api.endMove}
				className={`pk-tree-row${over ? " is-drop-target" : ""}${
					dragging ? " is-dragging" : ""
				}${ignored ? " is-ignored" : ""}`}
				data-dragging={dragging ? "true" : undefined}
				title={title}
				style={{ paddingLeft: `${level * 16 - 8}px` }}
				data-drop-dir={isDir ? path : dir}
			>
				{/* The right-click menu covers the row itself, not its ⋯ button:
				    the two menu families cannot be nested. */}
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<span className="pk-tree-face">
							<RowFace
								name={entry.name}
								shown={shown}
								isDir={isDir}
								open={open}
								status={status}
								decoration={decoration}
								dirty={dirty}
								ignored={ignored}
							/>
						</span>
					</ContextMenuTrigger>
					<Menu label={`Actions for ${shown}`}>
						<RowMenuItems node={node} />
					</Menu>
				</ContextMenu>
				<MenuRoot
					open={api.menuPath === path}
					onOpenChange={(value) => api.setMenuPath(value ? path : null)}
				>
					<MenuTrigger asChild>
						{/* Not a Tab stop: the row is, and Shift+F10 opens this. */}
						<IconButton
							icon="more"
							label={`Actions for ${shown}`}
							size="sm"
							tabIndex={-1}
							className="pk-tree-actions"
							data-testid={`file-menu-${path}`}
							onClick={(event) => event.stopPropagation()}
							// A dialog opened from this menu returns focus here on close;
							// hand it on to the row, the tree's Tab stop.
							onFocus={() => rowRef.current?.focus()}
						/>
					</MenuTrigger>
					<Menu
						label={`Actions for ${shown}`}
						onCloseAutoFocus={(event) => {
							// Back to the row, the tree's one Tab stop, not the hidden button.
							event.preventDefault();
							rowRef.current?.focus();
						}}
					>
						<RowMenuItems node={node} />
					</Menu>
				</MenuRoot>
			</div>
			{open ? (
				/* biome-ignore lint/a11y/useSemanticElements: the ARIA tree pattern wants a group */
				<div role="group" className="pk-tree-group">
					<Directory dir={path} level={level + 1} />
				</div>
			) : null}
		</div>
	);
});

/** New file and New folder, for the project root or for a directory. */
export function CreateMenuItems({
	dir,
	testIdPrefix,
}: {
	dir: string;
	testIdPrefix: string;
}): ReactNode {
	const api = useTreeApi();
	return (
		<>
			<MenuItem onSelect={() => api.newIn(dir, "file")}>
				<span data-testid={`${testIdPrefix}-new-file`}>New file…</span>
			</MenuItem>
			<MenuItem onSelect={() => api.newIn(dir, "dir")}>
				<span data-testid={`${testIdPrefix}-new-folder`}>New folder…</span>
			</MenuItem>
		</>
	);
}

/** The same actions on the right-click menu and on the row's ⋯ button. */
function RowMenuItems({ node }: { node: FileNode }): ReactNode {
	const api = useTreeApi();
	// A new file or folder goes inside a directory, or beside a file.
	const dir = node.isDir ? node.path : parentOf(node.path);
	// A menu opened on a selected row acts on the whole selection.
	const targets = api.targetsFor(node);
	const many = targets.length > 1;

	return (
		<>
			<CreateMenuItems dir={dir} testIdPrefix="row" />
			<MenuSeparator />
			{many ? null : (
				<MenuItem onSelect={() => api.rename(node)}>
					<span data-testid="row-rename">Rename…</span>
				</MenuItem>
			)}
			<MenuItem onSelect={() => api.move(node)}>
				<span data-testid="row-move">
					{many ? `Move ${targets.length} items to…` : "Move to…"}
				</span>
			</MenuItem>
			{many ? (
				<MenuItem onSelect={() => api.download(targets)}>
					<span data-testid="row-download-selection">
						Download {targets.length} items as zip
					</span>
				</MenuItem>
			) : (
				<MenuItem
					onSelect={() => api.download([node])}
					testId={`row-download-${node.path}`}
				>
					Download
				</MenuItem>
			)}
			{!many && !node.isDir && /\.zip$/i.test(node.name) ? (
				<MenuItem
					onSelect={() => api.extract(node)}
					testId={`row-extract-${node.path}`}
				>
					Extract here
				</MenuItem>
			) : null}
			{/* The picker belongs to the pane, because the menu closes on select. */}
			<MenuItem onSelect={() => api.pickUpload(dir)}>
				<span data-testid="row-upload">Upload files…</span>
			</MenuItem>
			<MenuSeparator />
			<MenuItem danger onSelect={() => api.remove(node)}>
				<span data-testid="row-delete">
					{many ? `Delete ${targets.length} items…` : "Delete…"}
				</span>
			</MenuItem>
		</>
	);
}
