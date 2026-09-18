/**
 * A file tab: the Monaco editor, autosave and conflict resolution
 * (SPEC.md §8.3, §13.1, §13.3, §13.5). Local text is never thrown away
 * without the student clicking a button.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { Button, EmptyState, PaneHandle } from "@portikus/ui";
import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import { ApiError } from "../api/request.js";
import type { CodeEditorHandle } from "../editor/CodeEditor.js";
import { scrollRatio, scrollTopForRatio } from "../editor/scrollSync.js";
import { useEditorSettings } from "../editor/settingsQueries.js";
import {
	FileConflictError,
	fileDownloadUrl,
	flushWrite,
	useFile,
	useSaveFile,
} from "../files/queries.js";
import { useEditorViewState } from "../layout/store.js";
import { DiffLeaf } from "./DiffLeaf.js";

// Monaco is large, so it is its own chunk and is only fetched when a file tab
// is actually opened (STACK.md §3).
const CodeEditor = lazy(() =>
	import("../editor/CodeEditor.js").then((module) => ({ default: module.CodeEditor })),
);

// The Markdown preview is its own chunk for the same reason: a student who
// only ever opens code files never downloads it.
const MarkdownPreview = lazy(() =>
	import("../editor/MarkdownPreview.js").then((module) => ({
		default: module.MarkdownPreview,
	})),
);

// The conflict view is the same Monaco diff editor the Changes view uses.
const DiffViewer = lazy(() =>
	import("../editor/DiffViewer.js").then((module) => ({ default: module.DiffViewer })),
);

/** The editor, or this file's changes against the last commit (issue #160). */
type View = "edit" | "diff";

/** The tab is hidden, not unmounted, so the editor keeps its undo history. */
const HIDDEN = { display: "none" } as const;

/**
 * How close two positions have to be to count as the same place. A side that
 * is put where it already is reports a scroll of its own; this is how that
 * echo is told from a student's own small scroll (issue #218).
 */
const SAME_PLACE = 0.001;

/** True for the file names that open as Markdown. */
function isMarkdownPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

type Status = "loading" | "saved" | "unsaved" | "saving" | "conflict" | "failed";

const STATUS_LABEL: Record<Status, string> = {
	loading: "Loading…",
	saved: "Saved",
	unsaved: "Unsaved",
	saving: "Saving…",
	conflict: "Conflict",
	failed: "Save failed",
};

export interface FileLeafProps {
	path: string;
	workspaceId: string;
	projectId: string;
	/** Close this tab: offered when the file is gone (SPEC.md §13.3). */
	onClose: () => void;
	/** The line this tab was last asked to open at, or undefined for none. */
	pendingLine?: number;
	/** Take that line from the layout store, so it is acted on only once. */
	consumePendingLine?: () => number | undefined;
	/** Counts the times this tab was asked to show its diff (issue #160). */
	pendingDiff?: number;
	/** Take that request from the layout store, so it is acted on once. */
	consumePendingDiff?: () => boolean;
	/** Counts the times this tab was asked to show the editor again. */
	pendingEdit?: number;
	/** Take that request from the layout store, so it is acted on once. */
	consumePendingEdit?: () => boolean;
	/** False while this tab is in the background. */
	visible?: boolean;
}

export function FileLeaf({
	path,
	workspaceId,
	projectId,
	onClose,
	pendingLine,
	consumePendingLine,
	pendingDiff,
	consumePendingDiff,
	pendingEdit,
	consumePendingEdit,
	visible = true,
}: FileLeafProps) {
	// The student's own editor settings (issue #159). They load once per
	// session; until they arrive the editor uses the defaults.
	const settingsQuery = useEditorSettings();
	const settings = settingsQuery.data ?? EDITOR_SETTINGS_DEFAULTS;
	// Where the cursor and scroll were when this file was last on screen, so
	// leaving the workspace and coming back puts them back (issue #161).
	const viewState = useEditorViewState(path);
	const file = useFile(workspaceId, projectId, path);
	const save = useSaveFile(workspaceId, projectId, path);

	// `text` is null until the first load; `etag` is the version the text was
	// edited from; `dirty` says the student has changes the server has not seen.
	const [text, setText] = useState<string | null>(null);
	const [etag, setEtag] = useState("");
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>("loading");
	// The version on disk that this tab's text no longer follows from, and
	// what that version says. Null when there is nothing to resolve.
	const [conflict, setConflict] = useState<{ etag: string; text: string } | null>(null);
	// A conflict opens as a diff; the student can put it aside and carry on
	// typing, and the banner brings the diff back (issue #158).
	const [showConflict, setShowConflict] = useState(false);
	// Counts the edits made on the conflict side. The editor below only takes
	// new text when its version changes, and typing in the conflict diff does
	// not change the etag, so without this counter "Keep editing" would come
	// back to an editor still holding the text from before those keystrokes.
	const [conflictEdits, setConflictEdits] = useState(0);
	// Which view this tab shows. It belongs to this browser and is not saved.
	const [view, setView] = useState<View>("edit");
	const markdown = isMarkdownPath(path);
	// The two sides of the Markdown split keep the same relative position
	// (issue #154, #218). Each side remembers the position it last put the
	// other one at, so it can recognise that side's answering scroll event.
	const editorScroll = useRef<CodeEditorHandle | null>(null);
	const previewScroll = useRef<HTMLDivElement | null>(null);
	const sentToPreview = useRef<number | null>(null);
	const sentToEditor = useRef<number | null>(null);
	// The preview may lag the keystrokes so typing stays smooth, but it is
	// never a frame behind on the first render.
	const previewText = useDeferredValue(text ?? "");
	// The file was deleted on disk while it was open, so the next save has to
	// create it rather than replace a version (SPEC.md §13.3).
	const [deleted, setDeleted] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// True while a write is in flight: a second one would send a stale etag
	// and be refused as a false conflict.
	const writing = useRef(false);
	// Every version this tab has already seen, so a refetch that was in flight
	// during a save cannot put the older text back.
	const known = useRef(new Set<string>());
	// The last few bodies this tab wrote. A write of its own makes the file
	// change on disk, which the project events socket reports, and that read
	// can come back before the write's own answer does. Without this the
	// editor would see its own text as someone else's edit (issue #157).
	const sent = useRef<string[]>([]);

	// A file can be opened at a line again while its tab is already there, so
	// the pending line is taken every time the store gets a new one, not only
	// on mount. The nonce makes a repeat of the same line a new request.
	const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
	const [revealReady, setRevealReady] = useState(false);
	const consume = useRef(consumePendingLine);
	consume.current = consumePendingLine;
	// biome-ignore lint/correctness/useExhaustiveDependencies: pendingLine is the trigger
	useEffect(() => {
		const line = consume.current?.();
		if (line !== undefined) {
			setReveal((current) => ({ line, nonce: (current?.nonce ?? 0) + 1 }));
		}
		setRevealReady(true);
	}, [pendingLine]);

	// Clicking a file in the Changes list puts its tab in diff view, whether
	// the tab was already open or not, so one path never has two tabs.
	const consumeDiff = useRef(consumePendingDiff);
	consumeDiff.current = consumePendingDiff;
	// biome-ignore lint/correctness/useExhaustiveDependencies: pendingDiff is the trigger
	useEffect(() => {
		if (consumeDiff.current?.()) setView("diff");
	}, [pendingDiff]);

	// Opening the file again from the tree or a terminal link takes a tab that
	// was left in diff view back to the editor.
	const consumeEdit = useRef(consumePendingEdit);
	consumeEdit.current = consumePendingEdit;
	// biome-ignore lint/correctness/useExhaustiveDependencies: pendingEdit is the trigger
	useEffect(() => {
		if (consumeEdit.current?.()) setView("edit");
	}, [pendingEdit]);

	// The save reads the newest text and etag, not the ones captured when the
	// timer was set.
	const latest = useRef({ text, etag, deleted });
	latest.current = { text, etag, deleted };

	// The pending timer reads the newest settings, so a change takes effect on
	// the next keystroke rather than on the next reload.
	const settingsRef = useRef(settings);
	settingsRef.current = settings;

	function cancelTimer() {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	}

	// Closing the tab or the browser mid-debounce must not lose the text, so
	// the pending write goes out with `keepalive` (SPEC.md §13.5).
	const flushOnUnmount = useRef(() => {});
	flushOnUnmount.current = () => {
		if (timer.current === null) return;
		clearTimeout(timer.current);
		timer.current = null;
		const current = latest.current;
		if (current.text === null) return;
		flushWrite(
			workspaceId,
			projectId,
			path,
			current.text,
			current.deleted ? null : current.etag,
		);
	};
	useEffect(
		() => () => {
			flushOnUnmount.current();
		},
		[],
	);

	async function write(body: string, against: string | null, retried = false) {
		// Three is enough to cover the reads that were already on their way
		// when this write went out.
		sent.current = [...sent.current.slice(-2), body];
		writing.current = true;
		setStatus("saving");
		setSaveError(null);
		try {
			const result = await save.mutateAsync({ text: body, etag: against });
			known.current.add(result.etag);
			setEtag(result.etag);
			setDeleted(false);
			setConflict(null);
			// The student may have typed while that write was in the air. Only
			// what was actually sent is saved; anything newer is still unsaved.
			if (latest.current.text === body) {
				setDirty(false);
				setStatus("saved");
			} else {
				setDirty(true);
				setStatus("unsaved");
				// With auto-save off the student asked for this save, so the
				// keystrokes that arrived during it go out at once rather than
				// waiting for another Ctrl+S.
				scheduleSave(settingsRef.current.autoSave ? undefined : 0);
			}
		} catch (error) {
			if (error instanceof FileConflictError) {
				// The refusal carries the version on disk but not its text, and
				// the conflict view needs both sides.
				const fresh = await file.refetch();
				const disk = fresh.data;
				const readable = disk !== undefined && !disk.binary && !disk.tooLarge;
				// The file on disk may hold a version this tab itself wrote or
				// loaded. Then nobody else has touched it, the refusal came from an
				// etag that had gone stale here, and a conflict would be a lie. Save
				// again against the version the server just gave, once (issue #157).
				if (
					!retried &&
					readable &&
					(known.current.has(disk.etag) || sent.current.includes(disk.text))
				) {
					await write(body, disk.etag, true);
					return;
				}
				setConflict({
					etag: readable ? disk.etag : error.etag,
					text: readable ? disk.text : "",
				});
				setShowConflict(true);
				setStatus("conflict");
				return;
			}
			setSaveError(error instanceof Error ? error.message : "The save failed.");
			setStatus("failed");
		} finally {
			writing.current = false;
		}
	}

	/**
	 * Write the newest text after `delayMs`. The default is the student's
	 * auto-save delay; a Ctrl+S that has more to write passes zero.
	 */
	function scheduleSave(delayMs = settingsRef.current.autoSaveDelaySeconds * 1000) {
		cancelTimer();
		timer.current = setTimeout(() => {
			timer.current = null;
			// One write at a time: a second would carry the etag the first is
			// about to replace. Wait another debounce instead.
			if (writing.current) {
				scheduleSave(delayMs);
				return;
			}
			const current = latest.current;
			if (current.text === null) return;
			void write(current.text, current.deleted ? null : current.etag);
		}, delayMs);
	}

	function onChange(next: string) {
		setText(next);
		setDirty(true);
		// An unresolved conflict waits for the student; autosaving would only
		// produce another 412 (SPEC.md §13.3).
		if (conflict !== null) return;
		setStatus("unsaved");
		// With auto-save off the text waits for Ctrl+S (SPEC.md §13.5).
		if (settingsRef.current.autoSave) scheduleSave();
	}

	/** A keystroke on the student's side of the conflict diff (issue #158). */
	function onConflictChange(next: string) {
		setConflictEdits((count) => count + 1);
		onChange(next);
	}

	function saveNow() {
		if (!dirty || conflict !== null) return;
		const current = latest.current;
		if (current.text === null) return;
		if (writing.current) {
			// A write is already in the air; this one follows it at once.
			scheduleSave(0);
			return;
		}
		cancelTimer();
		void write(current.text, current.deleted ? null : current.etag);
	}

	// What the server last sent decides what happens: the first load fills the
	// editor, a later change with no local edits refreshes it silently, and a
	// later change with local edits is a conflict (SPEC.md §13.3).
	const data = file.data;
	useEffect(() => {
		if (!data || data.binary || data.tooLarge) return;
		if (known.current.has(data.etag)) return;
		if (sent.current.includes(data.text)) {
			// This is the editor's own text coming back, not an outside edit.
			known.current.add(data.etag);
			// While a write is in flight its answer carries the etag to save
			// against next; this read may already be one version behind.
			if (!writing.current) setEtag(data.etag);
			if (text !== null && dirty) return;
		}
		if (text !== null && dirty) {
			setConflict({ etag: data.etag, text: data.text });
			setShowConflict(true);
			setStatus("conflict");
			return;
		}
		known.current.add(data.etag);
		setText(data.text);
		setEtag(data.etag);
		setDeleted(false);
		setStatus("saved");
	}, [data, text, dirty]);

	// A read that fails once the file is open keeps the editor: the student's
	// text is the only copy of their work (SPEC.md §13.3).
	const readError = file.error;
	const gone = readError instanceof ApiError && readError.status === 404;
	useEffect(() => {
		if (gone) setDeleted(true);
	}, [gone]);

	async function takeTheirs() {
		cancelTimer();
		const fresh = await file.refetch();
		if (!fresh.data) return;
		known.current.add(fresh.data.etag);
		setText(fresh.data.text);
		setEtag(fresh.data.etag);
		setDirty(false);
		setDeleted(false);
		setConflict(null);
		setShowConflict(false);
		setStatus("saved");
	}

	function keepMine() {
		cancelTimer();
		const current = latest.current;
		if (current.text === null || conflict === null) return;
		setShowConflict(false);
		void write(current.text, conflict.etag);
	}

	const viewer = data?.tooLarge === true || data?.binary === true;
	// The pill says nothing useful about a file that cannot be edited, and
	// while the editor is empty there is nothing to have saved.
	const showStatus = text !== null && !viewer;

	// The two sides of the Markdown split follow each other by relative
	// position: how far down its own scrollable range each side is (issue
	// #154, #218; SPEC.md §13.4). Putting one side in its place makes that
	// side report a scroll, which must not be sent straight back, so each
	// side ignores exactly the position it was just asked for.
	function followEditor(ratio: number) {
		const node = previewScroll.current;
		if (!node) return;
		if (sentToEditor.current !== null && near(ratio, sentToEditor.current)) {
			// The editor is only reporting the move the preview asked for.
			sentToEditor.current = null;
			return;
		}
		sentToPreview.current = ratio;
		node.scrollTop = scrollTopForRatio(ratio, node.scrollHeight, node.clientHeight);
	}

	function followPreview() {
		const node = previewScroll.current;
		if (!node) return;
		const ratio = scrollRatio(node.scrollTop, node.scrollHeight, node.clientHeight);
		if (sentToPreview.current !== null && near(ratio, sentToPreview.current)) {
			sentToPreview.current = null;
			return;
		}
		sentToEditor.current = ratio;
		editorScroll.current?.setScrollRatio(ratio);
	}

	function banner() {
		if (text === null) return null;
		if (gone) {
			return "This file was deleted on disk. Save to recreate it.";
		}
		if (readError) {
			return `Could not check the file on disk. ${readError.message}`;
		}
		if (status === "failed" && saveError !== null) return saveError;
		return null;
	}

	function body() {
		if (text === null && gone) {
			return (
				<EmptyState
					icon="file"
					title="This file was moved or deleted"
					actions={
						<Button variant="primary" onClick={onClose} data-testid="file-close">
							Close
						</Button>
					}
				>
					{path} is no longer in the project.
				</EmptyState>
			);
		}
		if (text === null && readError) {
			return (
				<EmptyState icon="file" title="This file could not be opened">
					{readError.message}
				</EmptyState>
			);
		}
		if (viewer && data) {
			return (
				<EmptyState
					icon="file"
					title={
						data.tooLarge ? "This file is too large to edit here" : "Not a text file"
					}
					actions={
						<a
							className="pk-file-download"
							href={fileDownloadUrl(workspaceId, projectId, path)}
							data-testid="file-download"
						>
							Download
						</a>
					}
				>
					{data.size > 0
						? `${path} is ${formatSize(data.size)}. Download it to open it elsewhere.`
						: `${path} cannot be shown here. Download it to open it elsewhere.`}
				</EmptyState>
			);
		}
		if (text === null || !revealReady) {
			return <p className="pk-file-note">Loading…</p>;
		}
		const editor = (
			<Suspense fallback={<p className="pk-file-note">Loading editor…</p>}>
				<CodeEditor
					path={path}
					projectId={projectId}
					value={text}
					version={`${etag}:${conflictEdits}`}
					onChange={onChange}
					onSave={saveNow}
					wordWrap={settings.wordWrap ? "on" : "off"}
					revealLine={reveal?.line}
					revealNonce={reveal?.nonce}
					viewState={viewState.initial}
					onViewState={viewState.save}
					ref={markdown ? editorScroll : undefined}
					onScrollRatio={markdown && !inDiff ? followEditor : undefined}
				/>
			</Suspense>
		);
		if (!markdown) return editor;
		// A Markdown tab is always a split: the raw text on the left, and on
		// the right either the rendered file or its diff (SPEC.md §13.4,
		// issue #218). The preview is read-only; every edit happens in Monaco.
		const preview = (
			<Suspense fallback={<p className="pk-file-note">Loading preview…</p>}>
				<MarkdownPreview
					text={previewText}
					scrollRef={previewScroll}
					onScroll={followPreview}
				/>
			</Suspense>
		);
		return (
			<Group
				orientation="horizontal"
				className="pk-split pk-markdown-split"
				// react-resizable-panels copies the id onto data-testid.
				id="markdown-split"
			>
				<Panel id="md-code-pane" minSize="20%" className="pk-split-panel">
					{editor}
				</Panel>
				<PaneHandle orientation="vertical" label="Resize preview" />
				<Panel id="md-preview-pane" minSize="20%" className="pk-split-panel">
					{inDiff ? (
						<DiffLeaf
							path={path}
							workspaceId={workspaceId}
							projectId={projectId}
							visible={visible}
						/>
					) : (
						preview
					)}
				</Panel>
			</Group>
		);
	}

	const note = banner();
	// A Markdown tab shows its diff in the right pane, so only other tabs
	// hide the editor and put a diff tab in its place (issue #218).
	const inDiff = view === "diff";
	const diffInstead = inDiff && !markdown;
	// The version on disk on the left, the student's own text on the right and
	// still editable (issue #158). The editor below is hidden rather than
	// unmounted, so it keeps its undo history while the diff is up.
	const conflictDiff =
		conflict !== null && showConflict && text !== null ? (
			<Suspense fallback={<p className="pk-file-note">Loading diff…</p>}>
				<DiffViewer
					path={path}
					original={conflict.text}
					modified={text}
					version={conflict.etag}
					editable
					onChange={onConflictChange}
					testId={`conflict-editor-${path}`}
				/>
			</Suspense>
		) : null;
	// A Markdown tab has one button, because its diff replaces the preview
	// rather than the whole tab (issue #218). Every other tab still swaps
	// between the editor and the diff, so it needs both.
	const toggle = markdown ? (
		<fieldset className="pk-md-modes pk-view-modes">
			<legend className="pk-visually-hidden">File view</legend>
			<button
				type="button"
				aria-pressed={inDiff}
				onClick={() => setView(inDiff ? "edit" : "diff")}
				data-testid={`file-view-diff-${path}`}
			>
				Diff
			</button>
		</fieldset>
	) : (
		<fieldset className="pk-md-modes pk-view-modes">
			<legend className="pk-visually-hidden">File view</legend>
			<button
				type="button"
				aria-pressed={!inDiff}
				onClick={() => setView("edit")}
				data-testid={`file-view-edit-${path}`}
			>
				Edit
			</button>
			<button
				type="button"
				aria-pressed={inDiff}
				onClick={() => setView("diff")}
				data-testid={`file-view-diff-${path}`}
			>
				Diff
			</button>
		</fieldset>
	);

	return (
		<>
			<div
				className="pk-doc-leaf pk-file-leaf"
				data-testid={`file-pane-${path}`}
				style={diffInstead ? HIDDEN : undefined}
			>
				<div className="pk-file-header">
					<span className="pk-file-path">{path}</span>
					{/* Only the view on screen draws the toggle, so the controls
					    are never there twice. */}
					{diffInstead ? null : toggle}
					{showStatus ? (
						<span
							className="pk-file-status"
							data-testid={`file-status-${path}`}
							data-status={status}
						>
							{STATUS_LABEL[status]}
						</span>
					) : null}
				</div>
				{conflict !== null ? (
					<div className="pk-file-conflict" role="alert" data-testid="file-conflict">
						<span>
							This file changed on disk while you were editing it. The version on disk
							is on the left and yours is on the right; you can edit yours and save
							later.
						</span>
						<Button
							size="sm"
							variant="primary"
							onClick={keepMine}
							data-testid="keep-mine"
						>
							Keep mine
						</Button>
						<Button size="sm" onClick={() => void takeTheirs()} data-testid="take-disk">
							Take disk
						</Button>
						<Button
							size="sm"
							onClick={() => setShowConflict((shown) => !shown)}
							data-testid="keep-editing"
						>
							{showConflict ? "Keep editing" : "Show differences"}
						</Button>
					</div>
				) : null}
				{note !== null ? (
					<div className="pk-file-banner" role="status" data-testid="file-banner">
						{note}
					</div>
				) : null}
				{conflictDiff}
				<div
					className="pk-file-body"
					style={conflictDiff !== null ? HIDDEN : undefined}
				>
					{body()}
				</div>
			</div>
			{diffInstead ? (
				<DiffLeaf
					path={path}
					workspaceId={workspaceId}
					projectId={projectId}
					visible={visible}
					toolbar={toggle}
				/>
			) : null}
		</>
	);
}

/** True when two relative positions are the same place on screen. */
function near(one: number, other: number): boolean {
	return Math.abs(one - other) < SAME_PLACE;
}

/** A byte count a student can read. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
