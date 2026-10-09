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
	MAX_DOWNLOAD_PATHS,
	MAX_UPLOAD_BYTES,
	type Project,
} from "@portikus/contracts";
import {
	Button,
	IconButton,
	Menu,
	MenuCheckboxItem,
	MenuItem,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
	useToast,
} from "@portikus/ui";
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { filePaths } from "../layout/tree.js";
import { useTerminals } from "../terminal/useTerminals.js";
import { DeleteFileConfirm } from "./DeleteFileConfirm.js";
import { ExtractProgress } from "./ExtractProgress.js";
import {
	downloadErrorToast,
	extractErrorToast,
	fileErrorToast,
	isFileExists,
	selectionDownloadErrorToast,
	selectionNamesTooLongToast,
	selectionTooLongToast,
	tooLargeToast,
} from "./errors.js";
import "./files.css";
import { useStore } from "zustand";
import { ChangesList } from "./ChangesList.js";
import { decorations as buildDecorations, NO_DECORATIONS } from "./gitStatus.js";
import { MoveDialog } from "./MoveDialog.js";
import { NameDialog } from "./NameDialog.js";
import { useWatchLimited } from "./ProjectEvents.js";
import {
	baseName,
	displayName,
	isDescendant,
	joinPath,
	nameError,
	parentOf,
	visibleEntries,
	withoutNested,
} from "./paths.js";
import {
	directoryDownloadUrl,
	downloadCheckUrl,
	type FileMutations,
	fileDownloadUrl,
	selectionDownloadUrl,
	startDownload,
	useFileMutations,
	useTree,
} from "./queries.js";
import { useMoveAskingToReplace } from "./ReplaceFileConfirm.js";
import { createRowStateStore } from "./rowState.js";
import {
	actionTargets,
	type ClickModifiers,
	EMPTY_SELECTION,
	type FileNode,
	orderedSelection,
	pruneSelection,
	selectionAfterClick,
} from "./selection.js";
import { openAgentSession, sessionReviewLabel } from "./sessionReview.js";
import { useExpanded, useFileViewStore, useShowHidden } from "./store.js";
import { CreateMenuItems, RootDropZone, TreeListing } from "./TreeRows.js";
import { type TreeApi, TreeContext } from "./treeApi.js";
import { selectionAfterExtend, useFocusRepair } from "./treeKeys.js";
import { useGitStatus } from "./useGitStatus.js";
import { useTreeDragAndDrop } from "./useTreeDragAndDrop.js";

/** How many uploads are in flight at once, so a big drop stays polite. */
const UPLOAD_CONCURRENCY = 4;

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

	const [rowState] = useState(createRowStateStore);
	const { setFocusedPath, setSelection } = rowState.getState();
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

	/** A deleted file or folder closes the panes of everything in it, in splits too. */
	const afterRemove = useCallback(
		(path: string) => {
			pruneExpanded(project.id, path);
			const state = layoutStore.getState();
			const open = state.layout.tabs.flatMap((tab) => filePaths(tab.root));
			for (const file of open) {
				if (file === path || isDescendant(file, path)) state.closeFile(file);
			}
		},
		[layoutStore, project.id, pruneExpanded],
	);

	/** A file moved from here keeps its tab and its unsaved text (SPEC.md §11.2). */
	const afterMove = useCallback(
		(from: string, to: string) => {
			rewriteExpanded(project.id, from, to);
			layoutStore.getState().retargetTabs(from, to);
		},
		[layoutStore, project.id, rewriteExpanded],
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

	const { repairFocus, treeFocusHandlers } = useFocusRepair(rowState, rowElements);

	const clickRow = useCallback(
		(path: string, modifiers: ClickModifiers) => {
			const order = visibleNodes().map((node) => node.path);
			setSelection((current) =>
				selectionAfterClick(pruneSelection(current, order), path, modifiers, order),
			);
		},
		[visibleNodes, setSelection],
	);

	const extendTo = useCallback(
		(from: string, to: string) => {
			const order = visibleNodes().map((node) => node.path);
			setSelection((current) =>
				selectionAfterExtend(pruneSelection(current, order), from, to, order),
			);
		},
		[visibleNodes, setSelection],
	);

	/** What an action on one row applies to: the selection, or just that row. */
	const targetsFor = useCallback(
		(node: FileNode): FileNode[] => {
			const nodes = visibleNodes();
			const order = nodes.map((item) => item.path);
			// A row inside a selected folder is already covered by that folder.
			const paths = withoutNested(
				actionTargets(pruneSelection(rowState.getState().selection, order), node.path),
			);
			const byPath = new Map(nodes.map((item) => [item.path, item]));
			const resolve = (path: string): FileNode =>
				byPath.get(path) ?? { path, name: baseName(path), isDir: false };
			if (paths.length <= 1) return [paths[0] === undefined ? node : resolve(paths[0])];
			return orderedSelection({ paths, anchor: null }, order).map(resolve);
		},
		[rowState, visibleNodes],
	);

	/**
	 * Download one row as itself (a folder as a zip), or several selected
	 * rows as one zip named after the project (SPEC.md §11.2). The size cap
	 * is checked first, so a refusal is explained here.
	 */
	const download = useCallback(
		(nodes: readonly FileNode[]) => {
			const node = nodes[0];
			if (node === undefined) return;
			if (nodes.length === 1) {
				startDownload(
					node.isDir
						? directoryDownloadUrl(workspaceId, project.id, node.path)
						: fileDownloadUrl(workspaceId, project.id, node.path),
					downloadCheckUrl(workspaceId, project.id, node.path),
					node.isDir ? `${node.name}.zip` : node.name,
				).catch((error: unknown) => toast.show(downloadErrorToast(error)));
				return;
			}
			if (nodes.length > MAX_DOWNLOAD_PATHS) {
				toast.show(selectionTooLongToast());
				return;
			}
			const href = selectionDownloadUrl(
				workspaceId,
				project.id,
				nodes.map((item) => item.path),
			);
			if (href === null) {
				toast.show(selectionNamesTooLongToast());
				return;
			}
			startDownload(href, `${href}&check=1`, `${project.slug}.zip`).catch(
				(error: unknown) => toast.show(selectionDownloadErrorToast(error)),
			);
		},
		[project.id, project.slug, workspaceId, toast],
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

	const { uploadDrag, startMove, endMove, paneHandlers } = useTreeDragAndDrop({
		rowState,
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
				children: <ExtractProgress workspaceId={workspaceId} projectId={project.id} />,
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
		[project.id, setExpandedIn, toast, workspaceId],
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
			rowState,
			setFocusedPath,
			rowElements,
			visibleNodes,
			repairFocus,
			treeFocusHandlers,
			clickRow,
			extendTo,
			targetsFor,
			download,
			extract,
			treeRef: (element) => {
				treeElement.current = element;
			},
			startMove,
			endMove,
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
			rowState,
			setFocusedPath,
			rowElements,
			visibleNodes,
			repairFocus,
			treeFocusHandlers,
			clickRow,
			extendTo,
			targetsFor,
			download,
			extract,
			startMove,
			endMove,
			git,
			menuPath,
		],
	);

	const entries = root.data ? visibleEntries(root.data.entries, showHidden) : [];
	const empty = root.isSuccess && entries.length === 0;
	const allHidden = empty && (root.data?.entries.length ?? 0) > 0;
	const overRoot = useStore(rowState, (state) => state.dropDir === "");
	const uploadToRoot = uploadDrag && overRoot;

	return (
		<TreeContext.Provider value={api}>
			{/* The whole pane takes drags, so a file can go back to the project
			    root by the path line under the header (SPEC.md §11.2). */}
			<aside
				className="pk-pane pk-pane--right"
				aria-label="Files"
				onDragEnter={paneHandlers.onDragEnter}
				onDragOver={paneHandlers.onDragOver}
				onDragLeave={paneHandlers.onDragLeave}
				onDrop={paneHandlers.onDrop}
			>
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

				<div
					className={`pk-pane-body${uploadToRoot ? " is-upload-root" : ""}`}
					data-upload-root={uploadToRoot ? "true" : undefined}
					data-testid="file-tree-body"
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
	);
}
