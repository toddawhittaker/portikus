/**
 * The right pane: one project's files (SPEC.md §8.4, §11.2, §11.3). The tree
 * fetches one directory at a time, hides generated and dotted names until
 * the student asks for them, and offers create, rename, move, delete,
 * upload and download.
 *
 * Rows carry their Git state (SPEC.md §12.1) and the pane keeps one events
 * socket open, so a change made in a terminal shows here on its own
 * (SPEC.md §11.4, §12.3).
 */
import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	PointerSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	type BrowserOpenRequest,
	MAX_TREE_ENTRIES,
	MAX_UPLOAD_BYTES,
	type Project,
	type TreeEntry,
} from "@portikus/contracts";
import {
	Button,
	ContextMenu,
	ContextMenuTrigger,
	EmptyState,
	Icon,
	IconButton,
	Menu,
	MenuCheckboxItem,
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
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { useTerminals } from "../useTerminals.js";
import { BrowserOpenDialog } from "./BrowserOpenDialog.js";
import { DeleteFileConfirm } from "./DeleteFileConfirm.js";
import { fileErrorToast, isFileExists, tooLargeToast } from "./errors.js";
import "./files.css";
import { ChangesList } from "./ChangesList.js";
import { fileIconName } from "./fileIcon.js";
import {
	decorations as buildDecorations,
	type GitDecorations,
	isIgnored,
	NO_DECORATIONS,
} from "./gitStatus.js";
import { MoveDialog } from "./MoveDialog.js";
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
	withoutNested,
} from "./paths.js";
import {
	directoryDownloadUrl,
	type FileMutations,
	fileDownloadUrl,
	useFileMutations,
	useTree,
} from "./queries.js";
import {
	actionTargets,
	type ClickModifiers,
	EMPTY_SELECTION,
	orderedSelection,
	pruneSelection,
	type Selection,
	selectionAfterClick,
} from "./selection.js";
import { openAgentSession, sessionReviewLabel } from "./sessionReview.js";
import { useExpanded, useFileViewStore, useShowHidden } from "./store.js";
import { useGitStatus } from "./useGitStatus.js";
import { useProjectEvents } from "./useProjectEvents.js";

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
	move: (node: FileNode) => void;
	remove: (node: FileNode) => void;
	uploadInto: (dir: string, files: FileList | File[]) => void;
	pickUpload: (dir: string) => void;
	focusedPath: string | null;
	setFocusedPath: (path: string | null) => void;
	/** The row elements on screen, in the order they are drawn. */
	rowElements: () => HTMLElement[];
	/** The rows on screen, in the order they are drawn. */
	visibleNodes: () => FileNode[];
	/** The selected rows (SPEC.md §11.2). */
	selection: Selection;
	clickRow: (path: string, modifiers: ClickModifiers) => void;
	/** The rows an action on `path` applies to: the selection, or that row. */
	targetsFor: (node: FileNode) => FileNode[];
	download: (nodes: readonly FileNode[]) => void;
	/** The element holding the rows, so the drawn order can be read back. */
	treeRef: (element: HTMLElement | null) => void;
	dropDir: string | null;
	/** A desktop file drag is over the pane (SPEC.md §11.2, issue #183). */
	uploadDrag: boolean;
	/** Git decorations for the rows (SPEC.md §12.1). */
	git: GitDecorations;
	/** The row whose ⋯ menu is open, so the keyboard can open it (issue #366). */
	menuPath: string | null;
	setMenuPath: (path: string | null) => void;
}

const TreeContext = createContext<TreeApi | null>(null);

function useTreeApi(): TreeApi {
	const api = useContext(TreeContext);
	if (!api) throw new Error("the file tree row is outside its tree");
	return api;
}

/** The droppable id of a directory; the project root is the empty path. */
const dropId = (dir: string) => `dir:${dir}`;

/**
 * The empty area below the tree is a second way into the project root
 * (issue #237). It is its own element rather than the pane body, so it never
 * overlaps a row and the pointer can only be over one of the two.
 */
const ROOT_SPACE_DROP_ID = "root-space";

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
	const focusedTerminalId = useLayout(layoutStore, (state) => state.focusedTerminalId);
	const root = useTree(workspaceId, project.id, "");
	const terminals = useTerminals(workspaceId, project.id, true, () => {});
	const session = openAgentSession(terminals.terminals, focusedTerminalId);
	const [reviewSession, setReviewSession] = useState(false);
	const [browserOpens, setBrowserOpens] = useState<BrowserOpenRequest[]>([]);
	const seenOpens = useRef(new Set<string>());
	// One socket per open project keeps the tree, the open files and the Git
	// status fresh without polling (SPEC.md §11.4, §25.1). The same socket
	// carries browser-open requests (BROWSER-HANDLING.md §18).
	useProjectEvents(workspaceId, project.id, (request) => {
		if (seenOpens.current.has(request.requestId)) return;
		seenOpens.current.add(request.requestId);
		setBrowserOpens((queue) => [...queue, request]);
	});
	const gitStatus = useGitStatus(workspaceId, project.id);
	const baselineStatus = useGitStatus(workspaceId, project.id, {
		baseline: reviewSession ? (session?.baselineObjectId ?? undefined) : undefined,
	});
	useEffect(() => {
		if (!session) setReviewSession(false);
	}, [session]);
	const git = useMemo(
		() => (gitStatus.data ? buildDecorations(gitStatus.data) : NO_DECORATIONS),
		[gitStatus.data],
	);

	const [focusedPath, setFocusedPath] = useState<string | null>(null);
	const [dropDir, setDropDir] = useState<string | null>(null);
	const [uploadDrag, setUploadDrag] = useState(false);
	// How many pane elements the upload drag is currently inside. Moving onto a
	// child row fires a leave for the element behind it, so counting is the only
	// way to tell "moved within the pane" from "left the pane" (issue #220).
	const uploadDepth = useRef(0);
	const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [dialog, setDialog] = useState<
		| { kind: "none" }
		| { kind: "new"; dir: string; type: "file" | "dir" }
		| { kind: "rename"; node: FileNode }
		| { kind: "delete"; nodes: FileNode[] }
		| { kind: "move"; nodes: FileNode[] }
	>({ kind: "none" });
	const treeElement = useRef<HTMLElement | null>(null);
	const uploadInput = useRef<HTMLInputElement | null>(null);
	const uploadDir = useRef<string>("");
	// The mutations object is new on every render, so the handlers read it
	// through a ref and stay stable themselves.
	const mutationsRef = useRef<FileMutations>(mutations);
	mutationsRef.current = mutations;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);
	// What the pointer is carrying, so the drag has something visible to show
	// (issue #237). dnd-kit draws it in a DragOverlay at the pointer.
	const [dragged, setDragged] = useState<{ path: string; isDir: boolean } | null>(null);

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

	/** The row elements, read back from the tree in the order they are drawn. */
	const rowElements = useCallback(
		(): HTMLElement[] =>
			Array.from(
				treeElement.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [],
			),
		[],
	);

	/** The rows on screen, as nodes. */
	const visibleNodes = useCallback((): FileNode[] => {
		return rowElements().map((row) => {
			const path = row.getAttribute("data-path") ?? "";
			return {
				path,
				name: baseName(path),
				isDir: row.getAttribute("data-kind") === "dir",
			};
		});
	}, [rowElements]);

	const clickRow = useCallback(
		(path: string, modifiers: ClickModifiers) => {
			const order = visibleNodes().map((node) => node.path);
			setSelection((current) =>
				selectionAfterClick(pruneSelection(current, order), path, modifiers, order),
			);
		},
		[visibleNodes],
	);

	/** What an action on one row applies to: the selection, or just that row. */
	const targetsFor = useCallback(
		(node: FileNode): FileNode[] => {
			const nodes = visibleNodes();
			const order = nodes.map((item) => item.path);
			// A row inside a selected folder is already covered by that folder.
			const paths = withoutNested(
				actionTargets(pruneSelection(selection, order), node.path),
			);
			const byPath = new Map(nodes.map((item) => [item.path, item]));
			const resolve = (path: string): FileNode =>
				byPath.get(path) ?? { path, name: baseName(path), isDir: false };
			if (paths.length <= 1) return [paths[0] === undefined ? node : resolve(paths[0])];
			return orderedSelection({ paths, anchor: null }, order).map(resolve);
		},
		[selection, visibleNodes],
	);

	/**
	 * Download a selection. The download endpoint takes one path, so several
	 * rows become one zip each, a moment apart so the browser keeps them all.
	 */
	const download = useCallback(
		(nodes: readonly FileNode[]) => {
			nodes.forEach((node, index) => {
				setTimeout(() => {
					const link = document.createElement("a");
					link.href = node.isDir
						? directoryDownloadUrl(workspaceId, project.id, node.path)
						: fileDownloadUrl(workspaceId, project.id, node.path);
					link.download = node.isDir ? `${node.name}.zip` : node.name;
					document.body.append(link);
					link.click();
					link.remove();
				}, index * 150);
			});
		},
		[project.id, workspaceId],
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
			openFileTab(node.path);
		},
		[openFileTab],
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
			move: (node) => setDialog({ kind: "move", nodes: targetsFor(node) }),
			remove: (node) => setDialog({ kind: "delete", nodes: targetsFor(node) }),
			uploadInto,
			pickUpload,
			focusedPath,
			setFocusedPath,
			rowElements,
			visibleNodes,
			selection,
			clickRow,
			targetsFor,
			download,
			treeRef: (element) => {
				treeElement.current = element;
			},
			dropDir,
			uploadDrag,
			git,
			menuPath,
			setMenuPath,
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
			rowElements,
			visibleNodes,
			selection,
			clickRow,
			targetsFor,
			download,
			dropDir,
			uploadDrag,
			git,
			menuPath,
		],
	);

	function onDragStart(event: DragStartEvent) {
		const id = String(event.active.id);
		if (!id.startsWith("row:")) return;
		setDragged({
			path: id.slice("row:".length),
			isDir: event.active.data.current?.isDir === true,
		});
	}

	function onDragEnd(event: DragEndEvent) {
		setDropDir(null);
		setDragged(null);
		const over = event.over ? String(event.over.id) : null;
		const move = moveForDrop(
			String(event.active.id),
			// The empty space below the tree means the project root.
			over === ROOT_SPACE_DROP_ID ? dropId("") : over,
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
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragCancel={() => {
				setDropDir(null);
				setDragged(null);
			}}
		>
			<TreeContext.Provider value={api}>
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
								<CreateMenuItems dir="" testIdPrefix="files" />
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
								{/* The same create actions as a row's menu, on the project
							    root, so a project with no files still has them. */}
								<CreateMenuItems dir="" testIdPrefix="files-more" />
								<MenuSeparator />
								<MenuCheckboxItem
									checked={showHidden}
									onCheckedChange={() => toggleShowHidden(project.id)}
									testId="files-show-hidden"
								>
									Show hidden and generated files
								</MenuCheckboxItem>
								<MenuSeparator />
								<MenuItem onSelect={() => api.pickUpload("")}>
									<span data-testid="files-upload">Upload files…</span>
								</MenuItem>
								{/* A link, so the browser streams the download to disk. */}
								<MenuItem
									href={directoryDownloadUrl(workspaceId, project.id, "")}
									download={`${project.slug}.zip`}
									testId="files-download-project"
								>
									Download project
								</MenuItem>
							</Menu>
						</MenuRoot>
					</div>

					<RootDropZone slug={project.slug} />

					{/* Desktop drag-and-drop upload (SPEC.md §11.2). */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target, not a control */}
					<div
						className={`pk-pane-body${
							uploadDrag && (dropDir === "" || dropDir === null)
								? " is-upload-root"
								: ""
						}`}
						data-upload-root={
							uploadDrag && (dropDir === "" || dropDir === null) ? "true" : undefined
						}
						data-testid="file-tree-body"
						onDragOver={(event) => {
							if (!event.dataTransfer.types.includes("Files")) return;
							event.preventDefault();
							setUploadDrag(true);
							setDropDir(dirUnder(event.target));
						}}
						onDragEnter={(event) => {
							if (!event.dataTransfer.types.includes("Files")) return;
							uploadDepth.current += 1;
							setUploadDrag(true);
							setDropDir(dirUnder(event.target));
						}}
						onDragLeave={() => {
							if (uploadDepth.current === 0) return;
							uploadDepth.current -= 1;
							if (uploadDepth.current > 0) return;
							setDropDir(null);
							setUploadDrag(false);
						}}
						onDrop={(event) => {
							if (!event.dataTransfer.files.length) return;
							event.preventDefault();
							const dir = dirUnder(event.target);
							uploadDepth.current = 0;
							setDropDir(null);
							setUploadDrag(false);
							uploadInto(dir, event.dataTransfer.files);
						}}
					>
						{uploadDrag && (dropDir === "" || dropDir === null) ? (
							<p className="pk-upload-hint" data-testid="file-tree-root-hint">
								Drop to upload to {project.name}
							</p>
						) : null}
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
							<EmptyState
								icon="file"
								title="No files yet"
								actions={
									<Button
										size="sm"
										data-testid="files-empty-new-file"
										onClick={() => api.newIn("", "file")}
									>
										New file
									</Button>
								}
							>
								Create a file, upload one, or use a terminal.
							</EmptyState>
						) : (
							<>
								<TreeRoot slug={project.slug} />
								<RootSpaceDropZone name={project.name} />
							</>
						)}
					</div>

					{/* The Changes surface sits under the tree (SPEC.md §12.6). */}
					<ChangesList
						projectId={project.id}
						status={reviewSession ? baselineStatus.data : gitStatus.data}
						error={reviewSession ? baselineStatus.isError : gitStatus.isError}
						sessionLabel={
							reviewSession && session?.agent
								? sessionReviewLabel(session.agent)
								: undefined
						}
						onReviewSession={
							session && !reviewSession ? () => setReviewSession(true) : undefined
						}
						onShowGit={reviewSession ? () => setReviewSession(false) : undefined}
						onOpen={
							reviewSession && session?.baselineObjectId
								? (path) =>
										openFileTab(path, {
											diff: true,
											baseline: session.baselineObjectId ?? undefined,
										})
								: undefined
						}
					/>
					{browserOpens[0] ? (
						<BrowserOpenDialog
							request={browserOpens[0]}
							workspaceId={workspaceId}
							projectId={project.id}
							onOpenPreview={(port) => layoutStore.getState().openPreview(port)}
							onClose={() => setBrowserOpens((queue) => queue.slice(1))}
						/>
					) : null}

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
					{dialog.kind === "move" && (
						<MoveDialog
							workspaceId={workspaceId}
							projectId={project.id}
							slug={project.slug}
							nodes={dialog.nodes}
							showHidden={showHidden}
							pending={mutations.pending}
							onClose={() => setDialog({ kind: "none" })}
							onMove={(destination) => {
								// One at a time, so a failure stops the rest and is reported once.
								void (async () => {
									try {
										for (const node of dialog.nodes) {
											const to = joinPath(destination, node.name);
											await mutations.move.mutateAsync({ from: node.path, to });
											afterMove(node.path, to);
										}
										if (destination !== "") api.setOpen(destination, true);
										setSelection(EMPTY_SELECTION);
										setDialog({ kind: "none" });
									} catch (error) {
										fail(error);
									}
								})();
							}}
						/>
					)}
					{dialog.kind === "delete" && (
						<DeleteFileConfirm
							nodes={dialog.nodes}
							pending={mutations.pending}
							onClose={() => setDialog({ kind: "none" })}
							onConfirm={() => {
								const paths = dialog.nodes.map((node) => node.path);
								// One at a time, so a failure stops the rest and is reported once.
								void (async () => {
									try {
										for (const path of paths) {
											await mutations.remove.mutateAsync(path);
											afterRemove(path);
										}
										setSelection(EMPTY_SELECTION);
										setDialog({ kind: "none" });
									} catch (error) {
										fail(error);
									}
								})();
							}}
						/>
					)}
				</aside>
			</TreeContext.Provider>
			{/* The row stays where it is; a small copy of it follows the
			    pointer, so it is clear what is being dragged (issue #237). */}
			<DragOverlay dropAnimation={null}>
				{dragged ? (
					<div className="pk-tree-drag" data-testid="file-drag-overlay">
						<Icon
							name={dragged.isDir ? "folder" : fileIconName(baseName(dragged.path))}
							size="sm"
						/>
						<span>{displayName(baseName(dragged.path))}</span>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

/**
 * The empty area below the last row. Dropping a file here moves it to the
 * project root, which is otherwise only reachable through the path line
 * (issue #237, SPEC.md §11.2).
 */
function RootSpaceDropZone({ name }: { name: string }) {
	const drop = useDroppable({ id: ROOT_SPACE_DROP_ID });
	return (
		<div
			className={`pk-tree-space${drop.isOver ? " is-drop-target" : ""}`}
			ref={drop.setNodeRef}
			data-drop-dir=""
			data-testid="file-tree-space-drop"
			data-drop-over={drop.isOver ? "true" : undefined}
		>
			{drop.isOver ? <span>Move to {name}</span> : null}
		</div>
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
	const helpId = useId();
	const { treeRef } = api;
	useEffect(() => {
		treeRef(ref.current);
		return () => treeRef(null);
	}, [treeRef]);

	// The pane owns the one query for the rows on screen.
	const rows = api.rowElements;

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
			case "F10":
				if (!event.shiftKey) break;
				event.preventDefault();
				api.setMenuPath(path);
				break;
			case "ContextMenu":
				event.preventDefault();
				api.setMenuPath(path);
				break;
			case "Delete":
				// Delete acts on the selection when the focused row is part of it.
				event.preventDefault();
				api.remove({ path, name: baseName(path), isDir });
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
			aria-describedby={helpId}
			className="pk-tree"
			data-testid="file-tree"
			onKeyDown={onKeyDown}
		>
			<span id={helpId} className="pk-visually-hidden">
				Arrow keys move and open folders, Enter opens a file, Shift+F10 or the Menu key
				opens the actions for a row, Delete deletes it.
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
	// Git state: the file's own letter, or a dot when a directory holds a
	// change (SPEC.md §12.1).
	const decoration = api.git.byPath.get(path);
	const dirty = isDir && api.git.changedDirs.has(path);
	const ignored = api.git.repo && isIgnored(path, api.git.ignored);
	const title = decoration ? `${shown} — ${decoration.title}` : undefined;
	// What the letter, the dot and the muted colour say, in words (issue #362).
	const status = decoration
		? decoration.title
		: dirty
			? "contains changes"
			: ignored
				? "ignored"
				: null;
	const rowRef = useRef<HTMLDivElement | null>(null);

	const selected = api.selection.paths.includes(path);
	const drag = useDraggable({ id: `row:${path}`, data: { isDir } });
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
			ref={rowRef}
			role="treeitem"
			aria-level={level}
			aria-expanded={isDir ? open : undefined}
			aria-selected={
				selected || (api.selection.paths.length === 0 && api.focusedPath === path)
			}
			data-selected={selected ? "true" : undefined}
			tabIndex={api.focusedPath === path ? 0 : -1}
			data-path={path}
			data-kind={isDir ? "dir" : "file"}
			data-testid={`file-row-${path}`}
			data-git={decoration?.kind ?? (dirty ? "dir" : undefined)}
			data-ignored={ignored ? "true" : undefined}
			className="pk-tree-item"
			onFocus={() => api.setFocusedPath(path)}
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
			<div
				ref={(element) => {
					drag.setNodeRef(element);
					if (isDir) drop.setNodeRef(element);
				}}
				{...drag.listeners}
				{...dragAttributes}
				className={`pk-tree-row${over ? " is-drop-target" : ""}${
					drag.isDragging ? " is-dragging" : ""
				}${ignored ? " is-ignored" : ""}`}
				title={title}
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
								name={
									isDir ? (open ? "folder-open" : "folder") : fileIconName(entry.name)
								}
								size="md"
							/>
							<span className="pk-tree-name">{shown}</span>
							{status ? <span className="pk-visually-hidden">, {status}</span> : null}
							{ignored && !decoration && !dirty ? (
								<span className="pk-tree-tag" aria-hidden="true">
									ignored
								</span>
							) : null}
							{decoration ? (
								<>
									{decoration.kind === "conflict" ? (
										<Icon name="alert" size="sm" />
									) : null}
									<span className="pk-git-letter" aria-hidden="true">
										{decoration.letter}
									</span>
								</>
							) : dirty ? (
								<span className="pk-git-dot" aria-hidden="true" />
							) : null}
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
						{/* Not a Tab stop: the row is, and Shift+F10 opens this (issue #366). */}
						<IconButton
							icon="more"
							label={`Actions for ${shown}`}
							size="sm"
							tabIndex={-1}
							className="pk-tree-actions"
							data-testid={`file-menu-${path}`}
							onClick={(event) => event.stopPropagation()}
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
}

/** New file and New folder, for the project root or for a directory. */
function CreateMenuItems({
	dir,
	testIdPrefix,
}: {
	dir: string;
	testIdPrefix: string;
}): ReactNode {
	const api = useTreeApi();
	return (
		<>
			<MenuItem icon="file" onSelect={() => api.newIn(dir, "file")}>
				<span data-testid={`${testIdPrefix}-new-file`}>New file…</span>
			</MenuItem>
			<MenuItem icon="folder" onSelect={() => api.newIn(dir, "dir")}>
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
	// A menu opened on a selected row acts on the whole selection (issue #182).
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
						Download {targets.length} items
					</span>
				</MenuItem>
			) : (
				/* A link, so the browser streams the download to disk. */
				<MenuItem
					href={
						node.isDir
							? directoryDownloadUrl(api.workspaceId, api.projectId, node.path)
							: fileDownloadUrl(api.workspaceId, api.projectId, node.path)
					}
					download={node.isDir ? `${node.name}.zip` : node.name}
					testId={`row-download-${node.path}`}
				>
					Download
				</MenuItem>
			)}
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
