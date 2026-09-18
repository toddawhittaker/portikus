/**
 * A file tab: the Monaco editor, autosave and conflict resolution
 * (SPEC.md §8.3, §13.1, §13.3, §13.5). Local text is never thrown away
 * without the student clicking a button.
 */
import { Button, EmptyState } from "@portikus/ui";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/request.js";
import {
	FileConflictError,
	fileDownloadUrl,
	flushWrite,
	useFile,
	useSaveFile,
} from "../files/queries.js";

// Monaco is large, so it is its own chunk and is only fetched when a file tab
// is actually opened (STACK.md §3).
const CodeEditor = lazy(() =>
	import("../editor/CodeEditor.js").then((module) => ({ default: module.CodeEditor })),
);

/** How long after the last keystroke the text is written (SPEC.md §13.5). */
const AUTOSAVE_DELAY_MS = 750;

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
	/** False while this tab is in the background, which stops the polling. */
	visible?: boolean;
	/** Close this tab: offered when the file is gone (SPEC.md §13.3). */
	onClose: () => void;
	/** The line this tab was opened at, read once. */
	consumePendingLine?: () => number | undefined;
}

export function FileLeaf({
	path,
	workspaceId,
	projectId,
	visible = true,
	onClose,
	consumePendingLine,
}: FileLeafProps) {
	const file = useFile(workspaceId, projectId, path, visible);
	const save = useSaveFile(workspaceId, projectId, path);

	// `text` is null until the first load; `etag` is the version the text was
	// edited from; `dirty` says the student has changes the server has not seen.
	const [text, setText] = useState<string | null>(null);
	const [etag, setEtag] = useState("");
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>("loading");
	const [conflictEtag, setConflictEtag] = useState<string | null>(null);
	// The file was deleted on disk while it was open, so the next save has to
	// create it rather than replace a version (SPEC.md §13.3).
	const [deleted, setDeleted] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// True while a write is in flight: a second one would send a stale etag
	// and be refused as a false conflict.
	const writing = useRef(false);
	// Every version this tab has already seen, so a poll that was in flight
	// during a save cannot put the older text back.
	const known = useRef(new Set<string>());

	// StrictMode renders twice, so the pending line is read in an effect that
	// runs once rather than in a state initializer that does not.
	const revealLine = useRef<number | undefined>(undefined);
	const [revealReady, setRevealReady] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read once, on open
	useEffect(() => {
		revealLine.current = consumePendingLine?.();
		setRevealReady(true);
	}, []);

	// The save reads the newest text and etag, not the ones captured when the
	// timer was set.
	const latest = useRef({ text, etag, deleted });
	latest.current = { text, etag, deleted };

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

	async function write(body: string, against: string | null) {
		writing.current = true;
		setStatus("saving");
		setSaveError(null);
		try {
			const result = await save.mutateAsync({ text: body, etag: against });
			known.current.add(result.etag);
			setEtag(result.etag);
			setDeleted(false);
			setConflictEtag(null);
			// The student may have typed while that write was in the air. Only
			// what was actually sent is saved; anything newer is still unsaved.
			if (latest.current.text === body) {
				setDirty(false);
				setStatus("saved");
			} else {
				setDirty(true);
				setStatus("unsaved");
				scheduleSave();
			}
		} catch (error) {
			if (error instanceof FileConflictError) {
				setConflictEtag(error.etag);
				setStatus("conflict");
				return;
			}
			setSaveError(error instanceof Error ? error.message : "The save failed.");
			setStatus("failed");
		} finally {
			writing.current = false;
		}
	}

	function scheduleSave() {
		cancelTimer();
		timer.current = setTimeout(() => {
			timer.current = null;
			// One write at a time: a second would carry the etag the first is
			// about to replace. Wait another debounce instead.
			if (writing.current) {
				scheduleSave();
				return;
			}
			const current = latest.current;
			if (current.text === null) return;
			void write(current.text, current.deleted ? null : current.etag);
		}, AUTOSAVE_DELAY_MS);
	}

	function onChange(next: string) {
		setText(next);
		setDirty(true);
		// An unresolved conflict waits for the student; autosaving would only
		// produce another 412 (SPEC.md §13.3).
		if (conflictEtag !== null) return;
		setStatus("unsaved");
		scheduleSave();
	}

	function saveNow() {
		if (!dirty || conflictEtag !== null) return;
		const current = latest.current;
		if (current.text === null) return;
		if (writing.current) {
			scheduleSave();
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
		if (text !== null && dirty) {
			setConflictEtag(data.etag);
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
		setConflictEtag(null);
		setStatus("saved");
	}

	function keepMine() {
		cancelTimer();
		const current = latest.current;
		if (current.text === null || conflictEtag === null) return;
		void write(current.text, conflictEtag);
	}

	const viewer = data?.tooLarge === true || data?.binary === true;
	// The pill says nothing useful about a file that cannot be edited, and
	// while the editor is empty there is nothing to have saved.
	const showStatus = text !== null && !viewer;

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
		return (
			<Suspense fallback={<p className="pk-file-note">Loading editor…</p>}>
				<CodeEditor
					path={path}
					value={text}
					version={etag}
					onChange={onChange}
					onSave={saveNow}
					revealLine={revealLine.current}
				/>
			</Suspense>
		);
	}

	const note = banner();

	return (
		<div className="pk-doc-leaf pk-file-leaf" data-testid={`file-pane-${path}`}>
			<div className="pk-file-header">
				<span className="pk-file-path">{path}</span>
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
			{conflictEtag !== null ? (
				<div className="pk-file-conflict" role="alert" data-testid="file-conflict">
					<span>
						This file changed on disk while you were editing it. Keep your version or
						take the one on disk.
					</span>
					<Button
						size="sm"
						variant="primary"
						onClick={keepMine}
						data-testid="keep-mine"
					>
						Keep mine
					</Button>
					<Button size="sm" onClick={() => void takeTheirs()} data-testid="take-theirs">
						Take theirs
					</Button>
				</div>
			) : null}
			{note !== null ? (
				<div className="pk-file-banner" role="status" data-testid="file-banner">
					{note}
				</div>
			) : null}
			{body()}
		</div>
	);
}

/** A byte count a student can read. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
