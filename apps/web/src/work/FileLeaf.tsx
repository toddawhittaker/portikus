/**
 * A file tab: the Monaco editor, the viewers and the conflict view
 * (SPEC.md §8.3, §13.1, §13.3, §13.4). The text and its saving live in
 * useFileBuffer.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { Button, EmptyState, Icon, PaneHandle } from "@portikus/ui";
import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import type { CodeEditorHandle } from "../editor/CodeEditor.js";
import { lineForTop, readBlocks, topForLine } from "../editor/scrollSync.js";
import { useEditorSettings } from "../editor/settingsQueries.js";
import { DownloadFileButton } from "../files/DownloadFileButton.js";
import { baseName, displayName, parentOf } from "../files/paths.js";
import { fileInlineUrl, useTree } from "../files/queries.js";
import { viewerKind, viewerVersion } from "../files/viewable.js";
import {
	type PendingView,
	useEditorViewState,
	useFileGeneration,
} from "../layout/store.js";
import { formatBytes } from "../monitor/format.js";
import { CsvView } from "./CsvView.js";
import { DiffLeaf } from "./DiffLeaf.js";
import { FileHeader } from "./FilePane.js";
import { ImageView, PdfView } from "./FileViewer.js";
import { type BufferStatus, useFileBuffer } from "./useFileBuffer.js";

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

/**
 * The editor, or this file's changes against the last commit.
 * An SVG also has the picture it draws, and a CSV file its table.
 */
type View = "view" | "edit" | "diff";

/** The tab is hidden, not unmounted, so the editor keeps its undo history. */
const HIDDEN = { display: "none" } as const;

/**
 * How many pixels apart two preview positions can be and still count as the
 * same place. A side that is put where it already is reports a scroll of its
 * own; this is how that echo is told from a student's own scroll.
 */
const SAME_PLACE = 1;
/** Lines closer together than this are the same place; lines are fractional. */
const SAME_LINE = 0.01;

/** True for the file names that open as Markdown. */
function isMarkdownPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** True for the file names that open as a table. */
function isCsvPath(path: string): boolean {
	return path.toLowerCase().endsWith(".csv");
}

const STATUS_LABEL: Record<BufferStatus, string> = {
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
	/** What this tab was last asked to show: diff or editor, maybe at a line. */
	pendingView?: PendingView;
	/** Take that request from the layout store, so it is acted on only once. */
	consumePendingView?: () => PendingView | undefined;
	/** False while this tab is in the background. */
	visible?: boolean;
	/** Tells the tab strip whether this file has unsaved edits. */
	onUnsavedChange?: (unsaved: boolean) => void;
	/** Object id the diff compares against, or null for Git HEAD. */
	baseline?: string | null;
}

/**
 * A move that replaces this file mounts the tab again, so the editor of the
 * file that was overwritten does not stay on screen (SPEC.md §11.2).
 */
export function FileLeaf(props: FileLeafProps) {
	const generation = useFileGeneration(props.path);
	return <FileTab key={generation} {...props} />;
}

function FileTab({
	path,
	workspaceId,
	projectId,
	onClose,
	pendingView,
	consumePendingView,
	visible = true,
	onUnsavedChange,
	baseline,
}: FileLeafProps) {
	// The student's own editor settings. They load once per
	// session; until they arrive the editor uses the defaults.
	const settingsQuery = useEditorSettings();
	const settings = settingsQuery.data ?? EDITOR_SETTINGS_DEFAULTS;
	// Where the cursor and scroll were when this file was last on screen, so
	// leaving the workspace and coming back puts them back.
	const viewState = useEditorViewState(path);
	const buffer = useFileBuffer({
		workspaceId,
		projectId,
		path,
		settings,
		onUnsavedChange,
	});
	const { file, readError, gone } = buffer;
	const { text, etag, status, conflict, showConflict, conflictEdits, saveError } =
		buffer.state;
	// An image, SVG or PDF is shown rather than edited.
	const kind = viewerKind(path);
	// The listing gives a large viewed file the size and modified time its
	// read has no etag for; a change on disk refetches it.
	const listing = useTree(workspaceId, projectId, parentOf(path), kind !== null);
	const name = baseName(path);
	const shownPath = displayName(path);
	const listed = listing.data?.entries.find((entry) => entry.name === name);
	const svg = kind === "svg";
	const csv = isCsvPath(path);
	// Which view this tab shows. It belongs to this browser and is not saved.
	// An SVG opens as its picture and a CSV file as its table; the text is
	// one button away.
	const firstView: View = svg || csv ? "view" : "edit";
	const [view, setView] = useState<View>(firstView);
	// The pressed button is replaced by its twin in the other header, so the
	// keyboard is handed to the twin as it mounts.
	const focusView = useRef<View | null>(null);
	function pressView(next: View, button: View = next) {
		if (next !== view) focusView.current = button;
		setView(next);
	}
	function viewButtonRef(which: View) {
		return (button: HTMLButtonElement | null) => {
			if (button && focusView.current === which) {
				focusView.current = null;
				button.focus();
			}
		};
	}
	const markdown = isMarkdownPath(path);
	// The two sides of the Markdown split keep the same top line.
	// Each side remembers the place it last put the other one at, so it can
	// recognise that side's answering scroll event and not send it back.
	const editorScroll = useRef<CodeEditorHandle | null>(null);
	const previewScroll = useRef<HTMLDivElement | null>(null);
	const sentPreviewTop = useRef<number | null>(null);
	const sentEditorLine = useRef<number | null>(null);
	// The preview may lag the keystrokes so typing stays smooth, but it is
	// never a frame behind on the first render.
	const previewText = useDeferredValue(text ?? "");

	// A file can be opened again while its tab is already there, so the
	// request is taken every time the store gets a new one, not only on mount.
	// Clicking a file in the Changes list shows its diff; opening it from the
	// tree or a terminal link takes the tab back to the editor. The nonce
	// makes a repeat of the same line a new jump.
	const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
	const [revealReady, setRevealReady] = useState(false);
	const consume = useRef(consumePendingView);
	consume.current = consumePendingView;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the request's seq is the trigger
	useEffect(() => {
		const request = consume.current?.();
		const line = request?.line;
		if (line !== undefined) {
			setReveal((current) => ({ line, nonce: (current?.nonce ?? 0) + 1 }));
		}
		if (request?.mode === "diff") setView("diff");
		else if (request?.mode === "edit") setView(firstView);
		setRevealReady(true);
	}, [pendingView?.seq]);

	const data = file.data;

	// A PDF or raster image is shown even when it happens to hold no NUL byte
	// and the server calls it text.
	const viewer =
		data?.tooLarge === true ||
		data?.binary === true ||
		(data !== undefined && (kind === "image" || kind === "pdf"));
	// An SVG small enough to edit has a picture view and a text view.
	const svgModes = svg && !viewer;
	// So does a CSV file: its table and its text.
	const csvModes = csv && !viewer;
	const viewModes = svgModes || csvModes;
	// The pill says nothing useful about a file that cannot be edited, and
	// while the editor is empty there is nothing to have saved.
	const showStatus = text !== null && !viewer;
	// An image, a PDF, or a file too large or not text is only looked at: it
	// has no other view, and its diff would only say it changed in binary.
	// A raster image or PDF is known by its name before it loads.
	const viewOnly = viewer || kind === "image" || kind === "pdf";

	// The two sides of the Markdown split follow each other by source line:
	// the first line showing on the left is the first line showing on the
	// right (SPEC.md §13.4).
	// The preview is matched through the data-line attribute its blocks carry.
	// Putting one side in its place makes that side report a scroll, which
	// must not be sent straight back, so each side ignores exactly the place
	// it was just asked for.
	function followEditor(line: number) {
		if (
			sentEditorLine.current !== null &&
			Math.abs(sentEditorLine.current - line) < SAME_LINE
		) {
			// The editor is only reporting the move the other side asked for.
			sentEditorLine.current = null;
			return;
		}
		sentEditorLine.current = null;
		const node = previewScroll.current;
		if (!node) return;
		node.scrollTop = topForLine(readBlocks(node), line);
		// The browser clamps the offset, so remember where it actually landed.
		sentPreviewTop.current = node.scrollTop;
	}

	function followPreview() {
		const node = previewScroll.current;
		if (!node) return;
		if (
			sentPreviewTop.current !== null &&
			Math.abs(node.scrollTop - sentPreviewTop.current) < SAME_PLACE
		) {
			sentPreviewTop.current = null;
			return;
		}
		sentPreviewTop.current = null;
		const line = lineForTop(readBlocks(node), node.scrollTop);
		sentEditorLine.current = line;
		editorScroll.current?.setTopLine(line);
	}

	function banner() {
		if (text === null) return null;
		if (gone) {
			return "This file was deleted on disk. Save to recreate it.";
		}
		if (readError) {
			return `Could not check the file on disk. ${readError.message}`;
		}
		// Shown through later edits and retries until a save succeeds, so the
		// status region is not re-announced on every autosave (SPEC.md §25.8).
		if (saveError !== null) return saveError;
		return null;
	}

	const downloadButton = (
		<DownloadFileButton
			workspaceId={workspaceId}
			projectId={projectId}
			path={path}
			testId="file-download"
		/>
	);

	/** The panel for a file this tab cannot show: why, and Download. */
	function downloadPanel(title: string) {
		const size = data?.size ?? 0;
		return (
			<EmptyState icon="file" title={title} actions={downloadButton}>
				{size > 0
					? `${shownPath} is ${formatBytes(size)}. Download it to open it elsewhere.`
					: `${shownPath} cannot be shown here. Download it to open it elsewhere.`}
			</EmptyState>
		);
	}

	/** A file shown rather than edited: an image, an SVG, a PDF, or a download panel. */
	function viewerBody(data: NonNullable<typeof file.data>) {
		const inlineUrl = fileInlineUrl(
			workspaceId,
			projectId,
			path,
			viewerVersion(data.etag, listed),
		);
		if (kind === "image" || kind === "svg") {
			return (
				<ImageView
					src={inlineUrl}
					path={path}
					size={data.size}
					download={downloadButton}
					fallback={downloadPanel}
				/>
			);
		}
		if (kind === "pdf") {
			return (
				<PdfView
					url={inlineUrl}
					path={path}
					download={downloadButton}
					fallback={downloadPanel}
				/>
			);
		}
		return downloadPanel(
			data.tooLarge ? "This file is too large to edit here" : "Not a text file",
		);
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
					{shownPath} is no longer in the project.
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
		// Without an etag the viewer's address is versioned from the listing,
		// so showing it sooner would load the file twice.
		if (viewer && data && !data.etag && kind !== null && listing.isPending) {
			return <p className="pk-file-note">Loading…</p>;
		}
		if (viewer && data) return viewerBody(data);
		if (text === null || !revealReady) {
			return <p className="pk-file-note">Loading…</p>;
		}
		if (svgModes && view === "view") {
			// Drawn from the text in the tab, so it shows unsaved edits too, and
			// through `img`, where the SVG's own script cannot run.
			return (
				<ImageView
					src={svgDataUrl(text)}
					path={path}
					size={new TextEncoder().encode(text).length}
					download={downloadButton}
					fallback={downloadPanel}
				/>
			);
		}
		if (csvModes && view === "view") {
			return <CsvView path={path} text={text} onShowText={() => pressView("edit")} />;
		}
		const editor = (
			<Suspense fallback={<p className="pk-file-note">Loading editor…</p>}>
				<CodeEditor
					path={path}
					projectId={projectId}
					value={text}
					version={`${etag}:${conflictEdits}`}
					onChange={buffer.onChange}
					onSave={buffer.saveNow}
					wordWrap={settings.wordWrap ? "on" : "off"}
					revealLine={reveal?.line}
					revealNonce={reveal?.nonce}
					viewState={viewState.initial}
					onViewState={viewState.save}
					ref={markdown ? editorScroll : undefined}
					onTopLine={markdown ? followEditor : undefined}
				/>
			</Suspense>
		);
		if (!markdown) return editor;
		// A Markdown tab is always a split: the raw text on the left, and on
		// the right either the rendered file or its diff (SPEC.md §13.4).
		// The preview is read-only; every edit happens in Monaco.
		const preview = (
			<Suspense fallback={<p className="pk-file-note">Loading preview…</p>}>
				<MarkdownPreview
					text={previewText}
					path={path}
					imageUrl={(target) => fileInlineUrl(workspaceId, projectId, target)}
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
					{preview}
				</Panel>
			</Group>
		);
	}

	const note = banner();
	// The diff replaces the whole tab on every file, Markdown included
	// (SPEC.md §13.4).
	const inDiff = view === "diff" && !viewOnly;
	// The version on disk on the left, the student's own text on the right and
	// still editable. The editor below is hidden rather than
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
					onChange={buffer.onConflictChange}
					testId={`conflict-editor-${path}`}
				/>
			</Suspense>
		) : null;
	// A file that is only looked at has no other view to switch to.
	const toggle = viewOnly ? null : (
		<ViewButtons
			path={path}
			markdown={markdown}
			viewModes={viewModes}
			view={view}
			inDiff={inDiff}
			onPress={pressView}
			buttonRef={viewButtonRef}
		/>
	);

	return (
		<>
			<div
				className="pk-doc-leaf pk-file-leaf"
				data-testid={`file-pane-${path}`}
				style={inDiff ? HIDDEN : undefined}
			>
				{/* Only the view on screen draws the header, so its controls,
				    the drag handle and the actions menu are never there twice.
				    The status sits before the toggle so its changing width
				    never moves the buttons. */}
				{inDiff ? null : (
					<FileHeader path={path}>
						{showStatus ? <StatusPill path={path} status={status} /> : null}
						{toggle}
					</FileHeader>
				)}
				{conflict !== null ? (
					<ConflictBar
						showConflict={showConflict}
						onKeepMine={buffer.keepMine}
						onTakeDisk={() => void buffer.takeDisk()}
						onToggle={buffer.toggleConflict}
					/>
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
			{inDiff ? (
				<DiffLeaf
					path={path}
					workspaceId={workspaceId}
					projectId={projectId}
					visible={visible}
					toolbar={toggle}
					baseline={baseline ?? undefined}
				/>
			) : null}
		</>
	);
}

/**
 * The view buttons in the file header. A Markdown tab has one Diff button
 * that turns the diff on and off; every other tab swaps between its views
 * and the diff, so it needs a button for each.
 */
function ViewButtons({
	path,
	markdown,
	viewModes,
	view,
	inDiff,
	onPress,
	buttonRef,
}: {
	path: string;
	markdown: boolean;
	/** The file also has a picture or table view. */
	viewModes: boolean;
	view: View;
	inDiff: boolean;
	onPress: (next: View, button?: View) => void;
	buttonRef: (which: View) => (button: HTMLButtonElement | null) => void;
}) {
	if (markdown) {
		return (
			<fieldset className="pk-segmented">
				<legend className="pk-visually-hidden">File view</legend>
				<button
					type="button"
					ref={buttonRef("diff")}
					aria-pressed={inDiff}
					onClick={() => onPress(inDiff ? "edit" : "diff", "diff")}
					data-testid={`file-view-diff-${path}`}
				>
					Diff
				</button>
			</fieldset>
		);
	}
	const viewing = viewModes && view === "view";
	return (
		<fieldset className="pk-segmented">
			<legend className="pk-visually-hidden">File view</legend>
			{viewModes ? (
				<button
					type="button"
					ref={buttonRef("view")}
					aria-pressed={viewing}
					onClick={() => onPress("view")}
					data-testid={`file-view-view-${path}`}
				>
					View
				</button>
			) : null}
			<button
				type="button"
				ref={buttonRef("edit")}
				aria-pressed={!inDiff && !viewing}
				onClick={() => onPress("edit")}
				data-testid={`file-view-edit-${path}`}
			>
				Edit
			</button>
			<button
				type="button"
				ref={buttonRef("diff")}
				aria-pressed={inDiff}
				onClick={() => onPress("diff")}
				data-testid={`file-view-diff-${path}`}
			>
				Diff
			</button>
		</fieldset>
	);
}

/** The save state pill in the file header. */
function StatusPill({ path, status }: { path: string; status: BufferStatus }) {
	return (
		<span
			className="pk-file-status"
			data-testid={`file-status-${path}`}
			data-status={status}
		>
			{status === "saved" ? <Icon name="check" size="sm" /> : null}
			{STATUS_LABEL[status]}
		</span>
	);
}

/** The banner shown while the file on disk and the tab's text disagree (SPEC.md §13.3). */
function ConflictBar({
	showConflict,
	onKeepMine,
	onTakeDisk,
	onToggle,
}: {
	showConflict: boolean;
	onKeepMine: () => void;
	onTakeDisk: () => void;
	onToggle: () => void;
}) {
	return (
		<div className="pk-file-conflict" role="alert" data-testid="file-conflict">
			<span>
				This file changed on disk while you were editing it. The version on disk is on
				the left and yours is on the right; you can edit yours and save later.
			</span>
			<Button size="sm" variant="primary" onClick={onKeepMine} data-testid="keep-mine">
				Keep mine
			</Button>
			<Button size="sm" onClick={onTakeDisk} data-testid="take-disk">
				Take disk
			</Button>
			<Button size="sm" onClick={onToggle} data-testid="keep-editing">
				{showConflict ? "Keep editing" : "Show differences"}
			</Button>
		</div>
	);
}

/** An SVG's text as an address an `img` can draw. */
function svgDataUrl(text: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}
