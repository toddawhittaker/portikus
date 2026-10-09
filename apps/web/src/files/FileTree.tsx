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
import { DndContext, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import { MAX_UPLOAD_BYTES, type Project, type TreeEntry } from "@portikus/contracts";
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
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { useTerminals } from "../terminal/useTerminals.js";
import { DeleteFileConfirm } from "./DeleteFileConfirm.js";
import {
	downloadErrorToast,
	extractErrorToast,
	fileErrorToast,
	isFileExists,
	tooLargeToast,
} from "./errors.js";
import "./files.css";
import { ChangesList } from "./ChangesList.js";
import { fileIconName } from "./fileIcon.js";
import {
	decorations as buildDecorations,
	type GitDecoration,
	type GitDecorations,
	isIgnored,
	NO_DECORATIONS,
} from "./gitStatus.js";
import { MoveDialog } from "./MoveDialog.js";
import { NameDialog } from "./NameDialog.js";
import { useWatchLimited } from "./ProjectEvents.js";
import {
	baseName,
	displayName,
	entryCount,
	joinPath,
	nameError,
	parentOf,
	reseedFocus,
	showMorePath,
	tabIdsUnder,
	visibleEntries,
	withoutNested,
} from "./paths.js";
import {
	directoryDownloadUrl,
	downloadCheckUrl,
	type FileMutations,
	fileDownloadUrl,
	startDownload,
	useFileMutations,
	useTree,
} from "./queries.js";
import { useMoveAskingToReplace } from "./ReplaceFileConfirm.js";
import { ShowMoreRow } from "./ShowMoreRow.js";
import {
	actionTargets,
	type ClickModifiers,
	EMPTY_SELECTION,
	type FileNode,
	orderedSelection,
	pruneSelection,
	type Selection,
	selectionAfterClick,
} from "./selection.js";
import { openAgentSession, sessionReviewLabel } from "./sessionReview.js";
import { useExpanded, useFileViewStore, useShowHidden } from "./store.js";
import { selectionAfterExtend, useTreeKeys } from "./treeKeys.js";
import { useGitStatus } from "./useGitStatus.js";
import {
	dropId,
	ROOT_SPACE_DROP_ID,
	useTreeDragAndDrop,
} from "./useTreeDragAndDrop.js";

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
	/** Shift+Arrow: run the selection from the anchor to `to`. */
	extendTo: (from: string, to: string) => void;
	/** The rows an action on `path` applies to: the selection, or that row. */
	targetsFor: (node: FileNode) => FileNode[];
	download: (nodes: readonly FileNode[]) => void;
	/** "Extract here" on a zip, into a new folder beside it. */
	extract: (node: FileNode) => void;
	/** The element holding the rows, so the drawn order can be read back. */
	treeRef: (element: HTMLElement | null) => void;
	dropDir: string | null;
	/** A desktop file drag is over the pane (SPEC.md §11.2). */
	uploadDrag: boolean;
	/** Git decorations for the rows (SPEC.md §12.1). */
	git: GitDecorations;
	/** The row whose ⋯ menu is open, so the keyboard can open it. */
	menuPath: string | null;
	setMenuPath: (path: string | null) => void;
	/** Say something in the pane's polite status region. */
	announce: (text: string) => void;
}

const TreeContext = createContext<TreeApi | null>(null);

function useTreeApi(): TreeApi {
	const api = useContext(TreeContext);
	if (!api) throw new Error("the file tree row is outside its tree");
	return api;
}

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

/** The Changes list, showing Git or the open agent session's changes (SPEC.md §12.6). */
function PaneChanges({
	workspaceId,
	project,
	session,
	reviewSession,
	setReviewSession,
	gitStatus,
	baselineStatus,
	openFileTab,
}: {
	workspaceId: string;
	project: Project;
	session: ReturnType<typeof openAgentSession>;
	reviewSession: boolean;
	setReviewSession: (on: boolean) => void;
	gitStatus: ReturnType<typeof useGitStatus>;
	baselineStatus: ReturnType<typeof useGitStatus>;
	openFileTab: (path: string, options?: { diff?: boolean; baseline?: string }) => void;
}) {
	const shown = reviewSession ? baselineStatus : gitStatus;
	return (
		<ChangesList
			projectId={project.id}
			status={shown.data}
			error={shown.isError}
			sessionLabel={
				reviewSession && session?.agent ? sessionReviewLabel(session.agent) : undefined
			}
			onReviewSession={
				session && !reviewSession ? () => setReviewSession(true) : undefined
			}
			onShowGit={reviewSession ? () => setReviewSession(false) : undefined}
			sessionRestore={
				session?.recoveryPointId
					? { workspaceId, project, pointId: session.recoveryPointId }
					: undefined
			}
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
	);
}

/** What the tree area shows: an error, an empty project, or the tree itself. */
function TreeListing({
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
export function FileTreePane({
	workspaceId,
	project,
	onSearch,
	searchButtonRef,
}: {
	workspaceId: string;
	project: Project;
	/** Swap this pane for find in files (SPEC.md 11.5). */
	onSearch: () => void;
	/** Lets the caller return focus here when the search closes. */
	searchButtonRef?: Ref<HTMLButtonElement>;
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
	const terminals = useTerminals(workspaceId, project.id, true);
	const session = openAgentSession(terminals.terminals, focusedTerminalId);
	const [reviewSession, setReviewSession] = useState(false);
	// The workspace shell holds the events socket (SPEC.md §11.4).
	const watchLimited = useWatchLimited();
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
	const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
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
		const rows = rowElements().filter(
			(row) => row.getAttribute("data-kind") !== "more",
		);
		return rows.map((row) => {
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

	const extendTo = useCallback(
		(from: string, to: string) => {
			const order = visibleNodes().map((node) => node.path);
			setSelection((current) =>
				selectionAfterExtend(pruneSelection(current, order), from, to, order),
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
	 * Each is checked against the size cap first.
	 */
	const download = useCallback(
		(nodes: readonly FileNode[]) => {
			nodes.forEach((node, index) => {
				setTimeout(() => {
					startDownload(
						node.isDir
							? directoryDownloadUrl(workspaceId, project.id, node.path)
							: fileDownloadUrl(workspaceId, project.id, node.path),
						downloadCheckUrl(workspaceId, project.id, node.path),
						node.isDir ? `${node.name}.zip` : node.name,
					).catch((error: unknown) => toast.show(downloadErrorToast(error)));
				}, index * 150);
			});
		},
		[project.id, workspaceId, toast],
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

	const { moveAsking, confirm: replaceConfirm } = useMoveAskingToReplace(
		mutations.move.mutateAsync,
	);

	const { sensors, dragged, dropDir, uploadDrag, dndHandlers, uploadHandlers } =
		useTreeDragAndDrop({
			moveFile: moveAsking,
			afterMove,
			fail,
			uploadInto,
		});

	const openFile = useCallback(
		(node: FileNode) => {
			openFileTab(node.path);
		},
		[openFileTab],
	);

	const extract = useCallback(
		(node: FileNode) => {
			const name = displayName(node.name);
			// A large zip takes minutes, so the progress toast stays until the request settles.
			const dismissProgress = toast.show({
				title: `Extracting ${name}…`,
				persistent: true,
			});
			mutationsRef.current.extract
				.mutateAsync(node.path)
				.then(({ path }) => {
					dismissProgress();
					setExpandedIn(project.id, path, true);
					toast.show({
						tone: "success",
						title: `Extracted ${name} into ${baseName(path)}`,
					});
				})
				.catch((error: unknown) => {
					dismissProgress();
					toast.show(extractErrorToast(name, error));
				});
		},
		[project.id, setExpandedIn, toast],
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
			extendTo,
			targetsFor,
			download,
			extract,
			treeRef: (element) => {
				treeElement.current = element;
			},
			dropDir,
			uploadDrag,
			git,
			menuPath,
			setMenuPath,
			announce: setAnnouncement,
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
			extendTo,
			targetsFor,
			download,
			extract,
			dropDir,
			uploadDrag,
			git,
			menuPath,
		],
	);

	const entries = root.data ? visibleEntries(root.data.entries, showHidden) : [];
	const empty = root.isSuccess && entries.length === 0;
	const allHidden = empty && (root.data?.entries.length ?? 0) > 0;
	const uploadToRoot = uploadDrag && (dropDir === "" || dropDir === null);

	return (
		// The context wraps the header too, so a file can be dragged back to
		// the project root (SPEC.md §11.2).
		<DndContext
			sensors={sensors}
			onDragStart={dndHandlers.onDragStart}
			onDragEnd={dndHandlers.onDragEnd}
			onDragCancel={dndHandlers.onDragCancel}
		>
			<TreeContext.Provider value={api}>
				<aside className="pk-pane pk-pane--right" aria-label="Files">
					<div className="pk-pane-head pk-pane-head--actions">
						<h2 className="sr-only">Files</h2>
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
							ref={searchButtonRef}
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
								<MenuItem
									onSelect={() =>
										download([{ path: "", name: project.slug, isDir: true }])
									}
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
						className={`pk-pane-body${uploadToRoot ? " is-upload-root" : ""}`}
						data-upload-root={uploadToRoot ? "true" : undefined}
						data-testid="file-tree-body"
						onDragOver={uploadHandlers.onDragOver}
						onDragEnter={uploadHandlers.onDragEnter}
						onDragLeave={uploadHandlers.onDragLeave}
						onDrop={uploadHandlers.onDrop}
					>
						{/* The live region exists before its text, so the text is announced. */}
						{/* aria-live as well, so an open dialog's aria-hidden does not silence it. */}
						<div
							role="status"
							aria-live="polite"
							data-testid="files-watch-limited-region"
						>
							{watchLimited ? (
								<p className="pk-watch-limited" data-testid="files-watch-limited">
									This project is too large to update live. It refreshes when you return
									to the window.
								</p>
							) : null}
							{announcement ? (
								<p className="pk-visually-hidden" data-testid="files-announcement">
									{announcement}
								</p>
							) : null}
						</div>
						{uploadToRoot ? (
							<p className="pk-upload-hint" data-testid="file-tree-root-hint">
								Drop to upload to {project.name}
							</p>
						) : null}
						<TreeListing
							project={project}
							failed={root.isError}
							allHidden={allHidden}
							empty={empty}
							onRetry={() => void root.refetch()}
							onNewFile={() => api.newIn("", "file")}
						/>
					</div>

					{/* The Changes surface sits under the tree (SPEC.md §12.6). */}
					<PaneChanges
						workspaceId={workspaceId}
						project={project}
						session={session}
						reviewSession={reviewSession}
						setReviewSession={setReviewSession}
						gitStatus={gitStatus}
						baselineStatus={baselineStatus}
						openFileTab={openFileTab}
					/>

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
								void moveAsking(from, to, dialog.node.isDir)
									.then((moved) => {
										if (!moved) return;
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
											if (await moveAsking(node.path, to, node.isDir)) {
												afterMove(node.path, to);
											}
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
					{replaceConfirm}
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
			    pointer, so it is clear what is being dragged. */}
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
 * (SPEC.md §11.2).
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
	// The row to focus once the next page is drawn, so focus never drops to the page.
	const [focusAfterLoad, setFocusAfterLoad] = useState<string | null>(null);
	const { rowElements, setFocusedPath, announce, showHidden } = api;

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
					focused={api.focusedPath === morePath}
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
	// What the letter, the dot and the muted colour say, in words.
	const status = rowStatus(decoration, dirty, ignored);
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
			aria-selected={selected}
			data-selected={selected ? "true" : undefined}
			data-current={
				api.selection.paths.length === 0 && api.focusedPath === path
					? "true"
					: undefined
			}
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
						Download {targets.length} items
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
