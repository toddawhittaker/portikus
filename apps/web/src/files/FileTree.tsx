/**
 * The right pane: one project's files (SPEC.md §8.4, §11.2, §11.3). The tree
 * fetches one directory at a time, hides generated and dotted names until
 * the student asks for them, and offers create, rename, move, delete,
 * upload and download.
 *
 * Live updates from the workspace agent (SPEC.md §11.4) are a later task:
 * the agent publishes filesystem events already, but the API relay and the
 * browser consumer do not exist yet, so each open directory polls.
 */
import {
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	MAX_TREE_ENTRIES,
	MAX_UPLOAD_BYTES,
	type Project,
	type TreeEntry,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
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
	useToast,
} from "@portikus/ui";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { DeleteFileConfirm } from "./DeleteFileConfirm.js";
import { fileErrorToast, isFileExists, tooLargeToast } from "./errors.js";
import "./files.css";
import { NameDialog } from "./NameDialog.js";
import {
	baseName,
	displayName,
	joinPath,
	moveForDrop,
	nameError,
	parentOf,
	reseedFocus,
	tabIdsUnder,
	visibleEntries,
} from "./paths.js";
import {
	directoryDownloadUrl,
	type FileMutations,
	fileDownloadUrl,
	useFileMutations,
	useTree,
} from "./queries.js";
import { useExpanded, useFileViewStore, useShowHidden } from "./store.js";

/** A row of the tree: a project-relative path and what it is. */
export interface FileNode {
	path: string;
	name: string;
	isDir: boolean;
}

/** How many uploads are in flight at once, so a big drop stays polite. */
const UPLOAD_CONCURRENCY = 4;

interface TreeApi {
	workspaceId: string;
	projectId: string;
	showHidden: boolean;
	expanded: string[];
	toggle: (path: string) => void;
	setOpen: (path: string, open: boolean) => void;
	openFile: (node: FileNode) => void;
	newIn: (dir: string, kind: "file" | "dir") => void;
	rename: (node: FileNode) => void;
	remove: (node: FileNode) => void;
	uploadInto: (dir: string, files: FileList | File[]) => void;
	pickUpload: (dir: string) => void;
	focusedPath: string | null;
	setFocusedPath: (path: string | null) => void;
	dropDir: string | null;
}

const TreeContext = createContext<TreeApi | null>(null);

function useTreeApi(): TreeApi {
	const api = useContext(TreeContext);
	if (!api) throw new Error("the file tree row is outside its tree");
	return api;
}

/** The droppable id of a directory; the project root is the empty path. */
const dropId = (dir: string) => `dir:${dir}`;

/** Run `job` over `items`, never more than `limit` of them at once. */
async function runWithLimit<T>(
	items: readonly T[],
	limit: number,
	job: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			await job(next);
		}
	});
	await Promise.all(workers);
}

export function FileTreePane({
	workspaceId,
	project,
	onSearch,
}: {
	workspaceId: string;
	project: Project;
	/** Swap this pane for find in files (SPEC.md 11.5). */
	onSearch: () => void;
}) {
	const toast = useToast();
	const mutations = useFileMutations(workspaceId, project.id);
	const showHidden = useShowHidden(project.id);
	const expanded = useExpanded(project.id);
	const toggleExpanded = useFileViewStore((state) => state.toggleExpanded);
	const setExpandedIn = useFileViewStore((state) => state.setExpanded);
	const toggleShowHidden = useFileViewStore((state) => state.toggleShowHidden);
	const pruneExpanded = useFileViewStore((state) => state.pruneExpanded);
	const rewriteExpanded = useFileViewStore((state) => state.rewriteExpanded);
	const layoutStore = useLayoutStore(project.id);
	const openFileTab = useLayout(layoutStore, (state) => state.openFile);
	const root = useTree(workspaceId, project.id, "");

	const [focusedPath, setFocusedPath] = useState<string | null>(null);
	const [dropDir, setDropDir] = useState<string | null>(null);
	const [dialog, setDialog] = useState<
		| { kind: "none" }
		| { kind: "new"; dir: string; type: "file" | "dir" }
		| { kind: "rename"; node: FileNode }
		| { kind: "delete"; node: FileNode }
	>({ kind: "none" });
	const uploadInput = useRef<HTMLInputElement | null>(null);
	const uploadDir = useRef<string>("");
	// The mutations object is new on every render, so the handlers read it
	// through a ref and stay stable themselves.
	const mutationsRef = useRef<FileMutations>(mutations);
	mutationsRef.current = mutations;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);

	const fail = useCallback(
		(error: unknown) => {
			toast.show(fileErrorToast(error));
		},
		[toast],
	);

	/** A file that is gone, or that moved, takes its tabs with it. */
	const closeTabsUnder = useCallback(
		(path: string) => {
			const state = layoutStore.getState();
			const ids = tabIdsUnder(
				state.layout.tabs.map((tab) => tab.id),
				path,
			);
			for (const id of ids) state.closeTab(id);
		},
		[layoutStore],
	);

	const afterRemove = useCallback(
		(path: string) => {
			pruneExpanded(project.id, path);
			closeTabsUnder(path);
		},
		[closeTabsUnder, project.id, pruneExpanded],
	);

	const afterMove = useCallback(
		(from: string, to: string) => {
			rewriteExpanded(project.id, from, to);
			closeTabsUnder(from);
		},
		[closeTabsUnder, project.id, rewriteExpanded],
	);

	const uploadOne: (dir: string, file: File, replace: boolean) => Promise<void> =
		useCallback(
			async (dir: string, file: File, replace: boolean): Promise<void> => {
				try {
					await mutationsRef.current.upload.mutateAsync({
						path: joinPath(dir, file.name),
						file,
						replace,
					});
				} catch (error) {
					// A clash is the one failure with an obvious next step.
					if (!replace && isFileExists(error)) {
						toast.show({
							...fileErrorToast(error),
							actions: (
								<Button
									size="sm"
									variant="secondary"
									data-testid="upload-replace"
									onClick={() => void uploadOne(dir, file, true)}
								>
									Replace
								</Button>
							),
						});
						return;
					}
					fail(error);
				}
			},
			[fail, toast],
		);

	const uploadInto = useCallback(
		(dir: string, files: FileList | File[]) => {
			const accepted: File[] = [];
			for (const file of Array.from(files)) {
				// The browser hands over the name the disk had; check it here too.
				const bad = nameError(file.name);
				if (bad) {
					toast.show({
						tone: "danger",
						title: `${displayName(file.name)} cannot be uploaded`,
						children: bad,
					});
					continue;
				}
				if (file.size > MAX_UPLOAD_BYTES) {
					toast.show(tooLargeToast());
					continue;
				}
				accepted.push(file);
			}
			void runWithLimit(accepted, UPLOAD_CONCURRENCY, (file) =>
				uploadOne(dir, file, false),
			);
		},
		[toast, uploadOne],
	);

	const openFile = useCallback(
		(node: FileNode) => {
			if (!openFileTab(node.path)) {
				toast.show({
					tone: "warning",
					title: "Too many tabs are open. Close one to open another.",
				});
			}
		},
		[openFileTab, toast],
	);

	const pickUpload = useCallback((dir: string) => {
		uploadDir.current = dir;
		uploadInput.current?.click();
	}, []);

	const api = useMemo<TreeApi>(
		() => ({
			workspaceId,
			projectId: project.id,
			showHidden,
			expanded,
			toggle: (path) => toggleExpanded(project.id, path),
			setOpen: (path, open) => setExpandedIn(project.id, path, open),
			openFile,
			newIn: (dir, kind) => setDialog({ kind: "new", dir, type: kind }),
			rename: (node) => setDialog({ kind: "rename", node }),
			remove: (node) => setDialog({ kind: "delete", node }),
			uploadInto,
			pickUpload,
			focusedPath,
			setFocusedPath,
			dropDir,
		}),
		[
			workspaceId,
			project.id,
			showHidden,
			expanded,
			toggleExpanded,
			setExpandedIn,
			openFile,
			uploadInto,
			pickUpload,
			focusedPath,
			dropDir,
		],
	);

	function onDragEnd(event: DragEndEvent) {
		setDropDir(null);
		const move = moveForDrop(
			String(event.active.id),
			event.over ? String(event.over.id) : null,
		);
		if (!move) return;
		const { from, to } = move;
		void mutations.move
			.mutateAsync({ from, to })
			.then(() => afterMove(from, to))
			.catch(fail);
	}

	/** Which directory a desktop drag is over, from the row under the pointer. */
	function dirUnder(target: EventTarget | null): string {
		const element =
			target instanceof Element ? target.closest("[data-drop-dir]") : null;
		return element?.getAttribute("data-drop-dir") ?? "";
	}

	const entries = root.data ? visibleEntries(root.data.entries, showHidden) : [];
	const empty = root.isSuccess && entries.length === 0;
	const allHidden = empty && (root.data?.entries.length ?? 0) > 0;

	return (
		// The context wraps the header too, so a file can be dragged back to
		// the project root (SPEC.md §11.2).
		<DndContext
			sensors={sensors}
			onDragEnd={onDragEnd}
			onDragCancel={() => setDropDir(null)}
		>
			<aside className="pk-pane pk-pane--right" aria-label="Files">
				<div className="pk-pane-head">
					<h2 className="pk-pane-title">Files</h2>
					<MenuRoot>
						<MenuTrigger asChild>
							<IconButton
								icon="plus"
								label="New file or folder"
								size="sm"
								data-testid="files-new"
							/>
						</MenuTrigger>
						<Menu label="New file or folder">
							<MenuItem icon="file" onSelect={() => api.newIn("", "file")}>
								<span data-testid="files-new-file">New file…</span>
							</MenuItem>
							<MenuItem icon="folder" onSelect={() => api.newIn("", "dir")}>
								<span data-testid="files-new-folder">New folder…</span>
							</MenuItem>
						</Menu>
					</MenuRoot>
					<IconButton
						icon="search"
						label="Find in files"
						size="sm"
						data-testid="search-open"
						onClick={onSearch}
					/>
					<MenuRoot>
						<MenuTrigger asChild>
							<IconButton
								icon="more"
								label="More file actions"
								size="sm"
								data-testid="files-more"
							/>
						</MenuTrigger>
						<Menu label="More file actions">
							<div className="px-2 py-1.5" data-testid="files-show-hidden">
								<Checkbox
									label="Show hidden and generated files"
									description="node_modules, .git and dist are hidden"
									checked={showHidden}
									onChange={() => toggleShowHidden(project.id)}
								/>
							</div>
							<MenuSeparator />
							<MenuItem onSelect={() => api.pickUpload("")}>
								<span data-testid="files-upload">Upload files…</span>
							</MenuItem>
							<MenuItem>
								<a
									href={directoryDownloadUrl(workspaceId, project.id, "")}
									download={`${project.slug}.zip`}
									data-testid="files-download-project"
								>
									Download project
								</a>
							</MenuItem>
						</Menu>
					</MenuRoot>
				</div>

				<RootDropZone slug={project.slug} />

				<TreeContext.Provider value={api}>
					{/* Desktop drag-and-drop upload (SPEC.md §11.2). */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target, not a control */}
					<div
						className="pk-pane-body"
						data-testid="file-tree-body"
						onDragOver={(event) => {
							if (!event.dataTransfer.types.includes("Files")) return;
							event.preventDefault();
							setDropDir(dirUnder(event.target));
						}}
						onDragLeave={() => setDropDir(null)}
						onDrop={(event) => {
							if (!event.dataTransfer.files.length) return;
							event.preventDefault();
							const dir = dirUnder(event.target);
							setDropDir(null);
							uploadInto(dir, event.dataTransfer.files);
						}}
					>
						{root.isError ? (
							<EmptyState
								icon="alert"
								title="The files could not be listed"
								actions={
									<Button
										size="sm"
										data-testid="file-tree-retry"
										onClick={() => void root.refetch()}
									>
										Retry
									</Button>
								}
							>
								The workspace did not answer. Try again in a moment.
							</EmptyState>
						) : allHidden ? (
							<EmptyState icon="file" title="Nothing to show">
								Everything here is hidden. Turn on Show hidden files to see it.
							</EmptyState>
						) : empty ? (
							<EmptyState icon="file" title="No files yet">
								Create a file, upload one, or use a terminal.
							</EmptyState>
						) : (
							<TreeRoot slug={project.slug} />
						)}
					</div>
				</TreeContext.Provider>

				{/* One hidden input serves every upload action. */}
				<input
					ref={uploadInput}
					type="file"
					multiple
					className="hidden"
					data-testid="files-upload-input"
					onChange={(event) => {
						const files = event.target.files;
						if (files && files.length > 0) uploadInto(uploadDir.current, files);
						event.target.value = "";
					}}
				/>

				{dialog.kind === "new" && (
					<NameDialog
						title={dialog.type === "file" ? "New file" : "New folder"}
						description={
							dialog.dir === "" ? "In the project root." : `In ${dialog.dir}.`
						}
						label="Name"
						confirmLabel="Create"
						pending={mutations.pending}
						onClose={() => setDialog({ kind: "none" })}
						onSubmit={(name) => {
							const path = joinPath(dialog.dir, name);
							const run =
								dialog.type === "file"
									? mutations.createFile.mutateAsync(path)
									: mutations.createDirectory.mutateAsync(path);
							void run
								.then(() => {
									if (dialog.dir !== "") api.setOpen(dialog.dir, true);
									setDialog({ kind: "none" });
								})
								.catch(fail);
						}}
					/>
				)}
				{dialog.kind === "rename" && (
					<NameDialog
						title={`Rename ${displayName(dialog.node.name)}`}
						label="New name"
						confirmLabel="Rename"
						initial={dialog.node.name}
						pending={mutations.pending}
						onClose={() => setDialog({ kind: "none" })}
						onSubmit={(name) => {
							const from = dialog.node.path;
							const to = joinPath(parentOf(from), name);
							void mutations.move
								.mutateAsync({ from, to })
								.then(() => {
									afterMove(from, to);
									setDialog({ kind: "none" });
								})
								.catch(fail);
						}}
					/>
				)}
				{dialog.kind === "delete" && (
					<DeleteFileConfirm
						node={dialog.node}
						pending={mutations.pending}
						onClose={() => setDialog({ kind: "none" })}
						onConfirm={() => {
							const path = dialog.node.path;
							void mutations.remove
								.mutateAsync(path)
								.then(() => {
									afterRemove(path);
									setDialog({ kind: "none" });
								})
								.catch(fail);
						}}
					/>
				)}
			</aside>
		</DndContext>
	);
}

/** The path line under the header, and the drop target for the project root. */
function RootDropZone({ slug }: { slug: string }) {
	const drop = useDroppable({ id: dropId("") });
	return (
		<div
			className="pk-pane-sub"
			ref={drop.setNodeRef}
			data-drop-dir=""
			data-testid="file-tree-root-drop"
			data-drop-over={drop.isOver ? "true" : undefined}
		>
			~/projects/{slug}
		</div>
	);
}

/** The tree itself: the root listing plus whatever is expanded under it. */
function TreeRoot({ slug }: { slug: string }) {
	const api = useTreeApi();
	const ref = useRef<HTMLDivElement | null>(null);

	/** The rows on screen, in the order they are drawn. */
	const rows = useCallback(
		(): HTMLElement[] =>
			Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []),
		[],
	);

	// A focused row can vanish: it was deleted, moved, or its parent closed.
	// Checked after every render, because rows also arrive with a fetch.
	const { focusedPath, setFocusedPath } = api;
	useEffect(() => {
		const rendered = rows().map((row) => row.getAttribute("data-path") ?? "");
		const next = reseedFocus(focusedPath, rendered);
		if (next !== focusedPath) setFocusedPath(next);
	});

	function focusRow(element: HTMLElement | undefined) {
		if (!element) return;
		const path = element.getAttribute("data-path");
		if (path !== null) api.setFocusedPath(path);
		element.focus();
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		// A key pressed on the row's own button or link belongs to that control.
		if (event.target instanceof Element && event.target.closest("button, a, input")) {
			return;
		}
		const current =
			event.target instanceof Element
				? event.target.closest<HTMLElement>("[role=treeitem]")
				: null;
		if (!current) return;
		const path = current.getAttribute("data-path") ?? "";
		const isDir = current.getAttribute("data-kind") === "dir";
		const open = api.expanded.includes(path);
		const all = rows();
		const index = all.indexOf(current);

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				focusRow(all[index + 1]);
				break;
			case "ArrowUp":
				event.preventDefault();
				focusRow(all[index - 1]);
				break;
			case "ArrowRight":
				event.preventDefault();
				if (isDir && !open) api.setOpen(path, true);
				else if (isDir) focusRow(all[index + 1]);
				break;
			case "ArrowLeft": {
				event.preventDefault();
				if (isDir && open) {
					api.setOpen(path, false);
					break;
				}
				const parent = parentOf(path);
				const up = all.find((row) => row.getAttribute("data-path") === parent);
				focusRow(up);
				break;
			}
			case "Enter":
			case " ":
				event.preventDefault();
				if (isDir) api.toggle(path);
				else api.openFile({ path, name: baseName(path), isDir: false });
				break;
			default:
				break;
		}
	}

	return (
		// The ARIA tree pattern on plain elements: the roles carry the meaning.
		<div
			ref={ref}
			role="tree"
			aria-label={`Files in ${slug}`}
			className="pk-tree"
			data-testid="file-tree"
			onKeyDown={onKeyDown}
		>
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

	return (
		<>
			{entries.map((entry) => (
				<Row key={entry.name} dir={dir} entry={entry} level={level} />
			))}
			{query.data?.truncated ? (
				<div className="pk-tree-more" data-testid="file-tree-truncated">
					Showing the first {MAX_TREE_ENTRIES} entries
				</div>
			) : null}
		</>
	);
}

function Row({ dir, entry, level }: { dir: string; entry: TreeEntry; level: number }) {
	const api = useTreeApi();
	const path = joinPath(dir, entry.name);
	const isDir = entry.type === "dir";
	const node: FileNode = { path, name: entry.name, isDir };
	const open = isDir && api.expanded.includes(path);
	// A name is drawn without the characters that could disguise it.
	const shown = displayName(entry.name);

	const drag = useDraggable({ id: `row:${path}` });
	// dnd-kit offers a button role and a tab stop; the row outside is the
	// treeitem and the only thing the keyboard should reach.
	const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = drag.attributes;
	const drop = useDroppable({ id: dropId(path), disabled: !isDir });
	const over = isDir && (drop.isOver || api.dropDir === path);

	function activate() {
		api.setFocusedPath(path);
		if (isDir) api.toggle(path);
		else api.openFile(node);
	}

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles keys for every row
		<div
			role="treeitem"
			aria-level={level}
			aria-expanded={isDir ? open : undefined}
			aria-selected={api.focusedPath === path}
			tabIndex={api.focusedPath === path ? 0 : -1}
			data-path={path}
			data-kind={isDir ? "dir" : "file"}
			data-testid={`file-row-${path}`}
			className="pk-tree-item"
			onFocus={() => api.setFocusedPath(path)}
			onClick={(event) => {
				// A click inside a nested row belongs to that row, not this one.
				const row =
					event.target instanceof Element
						? event.target.closest("[role=treeitem]")
						: null;
				if (row !== event.currentTarget) return;
				activate();
			}}
		>
			<div
				ref={(element) => {
					drag.setNodeRef(element);
					if (isDir) drop.setNodeRef(element);
				}}
				{...drag.listeners}
				{...dragAttributes}
				className={`pk-tree-row${over ? " is-drop-target" : ""}${
					drag.isDragging ? " is-dragging" : ""
				}`}
				style={{ paddingLeft: `${level * 16 - 8}px` }}
				data-drop-dir={isDir ? path : dir}
			>
				{/* The right-click menu covers the row itself, not its ⋯ button:
				    the two menu families cannot be nested. */}
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<span className="pk-tree-face">
							<span className="pk-tree-twisty">
								{isDir ? (
									<Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
								) : null}
							</span>
							<Icon
								name={isDir ? (open ? "folder-open" : "folder") : "file"}
								size="md"
							/>
							<span className="pk-tree-name">{shown}</span>
						</span>
					</ContextMenuTrigger>
					<Menu label={`Actions for ${shown}`}>
						<RowMenuItems node={node} />
					</Menu>
				</ContextMenu>
				<MenuRoot>
					<MenuTrigger asChild>
						<IconButton
							icon="more"
							label={`Actions for ${shown}`}
							size="sm"
							className="pk-tree-actions"
							data-testid={`file-menu-${path}`}
							onClick={(event) => event.stopPropagation()}
						/>
					</MenuTrigger>
					<Menu label={`Actions for ${shown}`}>
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
}

/** The same actions on the right-click menu and on the row's ⋯ button. */
function RowMenuItems({ node }: { node: FileNode }): ReactNode {
	const api = useTreeApi();
	// A new file or folder goes inside a directory, or beside a file.
	const dir = node.isDir ? node.path : parentOf(node.path);

	return (
		<>
			<MenuItem icon="file" onSelect={() => api.newIn(dir, "file")}>
				<span data-testid="row-new-file">New file…</span>
			</MenuItem>
			<MenuItem icon="folder" onSelect={() => api.newIn(dir, "dir")}>
				<span data-testid="row-new-folder">New folder…</span>
			</MenuItem>
			<MenuSeparator />
			<MenuItem onSelect={() => api.rename(node)}>
				<span data-testid="row-rename">Rename…</span>
			</MenuItem>
			<MenuItem>
				{/* A plain link, so the browser streams the download to disk. */}
				<a
					href={
						node.isDir
							? directoryDownloadUrl(api.workspaceId, api.projectId, node.path)
							: fileDownloadUrl(api.workspaceId, api.projectId, node.path)
					}
					download={node.isDir ? `${node.name}.zip` : node.name}
					data-testid={`row-download-${node.path}`}
				>
					Download
				</a>
			</MenuItem>
			{/* The picker belongs to the pane, because the menu closes on select. */}
			<MenuItem onSelect={() => api.pickUpload(dir)}>
				<span data-testid="row-upload">Upload files…</span>
			</MenuItem>
			<MenuSeparator />
			<MenuItem danger onSelect={() => api.remove(node)}>
				<span data-testid="row-delete">Delete…</span>
			</MenuItem>
		</>
	);
}
