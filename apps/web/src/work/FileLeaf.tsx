/**
 * A file tab: the Monaco editor, autosave and conflict resolution
 * (SPEC.md §8.3, §13.1, §13.3, §13.5). Local text is never thrown away
 * without the student clicking a button.
 */
import { Button, EmptyState } from "@portikus/ui";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/request.js";
import { FileConflictError, fileUrl, useFile, useSaveFile } from "../files/useFile.js";

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
	/** Close this tab: offered when the file is gone (SPEC.md §13.3). */
	onClose: () => void;
	/** The line this tab was opened at, read once. */
	consumePendingLine?: () => number | undefined;
}

export function FileLeaf({
	path,
	workspaceId,
	projectId,
	onClose,
	consumePendingLine,
}: FileLeafProps) {
	const file = useFile(workspaceId, projectId, path);
	const save = useSaveFile(workspaceId, projectId, path);

	// `text` is null until the first load; `etag` is the version the text was
	// edited from; `dirty` says the student has changes the server has not seen.
	const [text, setText] = useState<string | null>(null);
	const [etag, setEtag] = useState("");
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>("loading");
	const [conflictEtag, setConflictEtag] = useState<string | null>(null);
	const [revealLine] = useState(() => consumePendingLine?.());
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Every version this tab has already seen, so a poll that was in flight
	// during a save cannot put the older text back.
	const known = useRef(new Set<string>());

	// The save reads the newest text and etag, not the ones captured when the
	// timer was set.
	const latest = useRef({ text, etag });
	latest.current = { text, etag };

	function cancelTimer() {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	}

	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);

	async function write(body: string, against: string) {
		setStatus("saving");
		try {
			const result = await save.mutateAsync({ text: body, etag: against });
			known.current.add(result.etag);
			setEtag(result.etag);
			setDirty(false);
			setConflictEtag(null);
			setStatus("saved");
		} catch (error) {
			if (error instanceof FileConflictError) {
				setConflictEtag(error.etag);
				setStatus("conflict");
				return;
			}
			setStatus("failed");
		}
	}

	function scheduleSave() {
		cancelTimer();
		timer.current = setTimeout(() => {
			timer.current = null;
			const current = latest.current;
			if (current.text === null) return;
			void write(current.text, current.etag);
		}, AUTOSAVE_DELAY_MS);
	}

	function onChange(next: string) {
		setText(next);
		setDirty(true);
		if (conflictEtag === null) setStatus("unsaved");
		scheduleSave();
	}

	function saveNow() {
		cancelTimer();
		const current = latest.current;
		if (current.text === null || !dirty) return;
		void write(current.text, current.etag);
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
		setStatus("saved");
	}, [data, text, dirty]);

	async function takeTheirs() {
		cancelTimer();
		const fresh = await file.refetch();
		if (!fresh.data) return;
		known.current.add(fresh.data.etag);
		setText(fresh.data.text);
		setEtag(fresh.data.etag);
		setDirty(false);
		setConflictEtag(null);
		setStatus("saved");
	}

	function keepMine() {
		cancelTimer();
		const current = latest.current;
		if (current.text === null || conflictEtag === null) return;
		void write(current.text, conflictEtag);
	}

	const gone = file.error instanceof ApiError && file.error.status === 404;

	function body() {
		if (gone) {
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
		if (file.error) {
			return (
				<EmptyState icon="file" title="This file could not be opened">
					{file.error.message}
				</EmptyState>
			);
		}
		if (data?.tooLarge || data?.binary) {
			return (
				<EmptyState
					icon="file"
					title={
						data.tooLarge ? "This file is too large to edit here" : "Not a text file"
					}
					actions={
						<a
							className="pk-file-download"
							href={fileUrl(workspaceId, projectId, path, true)}
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
		if (text === null) {
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
					revealLine={revealLine}
				/>
			</Suspense>
		);
	}

	return (
		<div className="pk-doc-leaf pk-file-leaf" data-testid={`file-pane-${path}`}>
			<div className="pk-file-header">
				<span className="pk-file-path">{path}</span>
				<span
					className="pk-file-status"
					data-testid={`file-status-${path}`}
					data-status={status}
				>
					{STATUS_LABEL[status]}
				</span>
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
