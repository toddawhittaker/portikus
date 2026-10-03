/**
 * The text a file tab holds and how it reaches the disk: autosave, version
 * checks, conflicts and a file deleted underneath the tab (SPEC.md §13.3,
 * §13.5). Local text is never thrown away without the student clicking a
 * button.
 */
import type { EditorSettings } from "@portikus/contracts";
import { useEffect, useReducer, useRef } from "react";
import { ApiError } from "../api/request.js";
import { isStorageFull, STORAGE_FULL_SAVE_MESSAGE } from "../files/errors.js";
import {
	FileConflictError,
	flushWrite,
	useFile,
	useSaveFile,
} from "../files/queries.js";

export type BufferStatus =
	| "loading"
	| "saved"
	| "unsaved"
	| "saving"
	| "conflict"
	| "failed";

/** A version of the file with its text. */
export interface Version {
	etag: string;
	text: string;
}

export interface BufferState {
	/** Null until the first load. */
	text: string | null;
	/** The version the text was edited from. */
	etag: string;
	/** The student has changes the server has not seen. */
	dirty: boolean;
	status: BufferStatus;
	/** The version on disk this text no longer follows from, or null. */
	conflict: Version | null;
	/** A conflict opens as a diff; the student can put it aside and carry on typing. */
	showConflict: boolean;
	/**
	 * Counts edits made on the conflict side. The editor only takes new text
	 * when its version changes, and typing in the conflict diff does not
	 * change the etag, so without this "Keep editing" would come back to stale
	 * text.
	 */
	conflictEdits: number;
	/** Deleted on disk, so the next save creates the file (SPEC.md §13.3). */
	deleted: boolean;
	saveError: string | null;
}

export type BufferAction =
	/**
	 * A read from the server with a version this tab has not seen. `own` is
	 * true when the text is one this tab wrote; `writing` when a write is in
	 * flight.
	 */
	| { type: "read"; version: Version; own: boolean; writing: boolean }
	| { type: "edit"; text: string; inConflictView: boolean }
	| { type: "saveStart" }
	/** `sent` is the body that was written. */
	| { type: "saveDone"; etag: string; sent: string }
	| { type: "saveFailed"; message: string }
	| { type: "conflict"; version: Version }
	| { type: "takeDisk"; version: Version }
	| { type: "keepMine" }
	| { type: "toggleConflict" }
	| { type: "deleted" };

export const INITIAL_BUFFER: BufferState = {
	text: null,
	etag: "",
	dirty: false,
	status: "loading",
	conflict: null,
	showConflict: false,
	conflictEdits: 0,
	deleted: false,
	saveError: null,
};

function enterConflict(state: BufferState, version: Version): BufferState {
	return { ...state, conflict: version, showConflict: true, status: "conflict" };
}

export function bufferReducer(state: BufferState, action: BufferAction): BufferState {
	switch (action.type) {
		case "read": {
			// The first load fills the editor, a later change with no local edits
			// refreshes it silently, and one with local edits is a conflict
			// (SPEC.md §13.3).
			let next = state;
			const editing = state.text !== null && state.dirty;
			if (action.own) {
				// The editor's own text coming back. While a write is in flight its
				// answer carries the etag to save against; this read may be behind.
				if (!action.writing) next = { ...next, etag: action.version.etag };
				if (editing) return next;
			}
			if (editing) return enterConflict(next, action.version);
			return {
				...next,
				text: action.version.text,
				etag: action.version.etag,
				deleted: false,
				status: "saved",
			};
		}
		case "edit": {
			const next = {
				...state,
				text: action.text,
				dirty: true,
				conflictEdits: state.conflictEdits + (action.inConflictView ? 1 : 0),
			};
			// An unresolved conflict waits for the student (SPEC.md §13.3).
			if (state.conflict !== null) return next;
			return { ...next, status: "unsaved" };
		}
		case "saveStart":
			return { ...state, status: "saving", saveError: null };
		case "saveDone": {
			const next = { ...state, etag: action.etag, deleted: false, conflict: null };
			// Only what was sent is saved; anything typed meanwhile is still unsaved.
			if (state.text === action.sent) return { ...next, dirty: false, status: "saved" };
			return { ...next, dirty: true, status: "unsaved" };
		}
		case "saveFailed":
			return { ...state, saveError: action.message, status: "failed" };
		case "conflict":
			return enterConflict(state, action.version);
		case "takeDisk":
			return {
				...state,
				text: action.version.text,
				etag: action.version.etag,
				dirty: false,
				deleted: false,
				conflict: null,
				showConflict: false,
				status: "saved",
			};
		case "keepMine":
			return { ...state, showConflict: false };
		case "toggleConflict":
			return { ...state, showConflict: !state.showConflict };
		case "deleted":
			return { ...state, deleted: true };
	}
}

/**
 * True when a refused write met a version on disk that this tab itself wrote
 * or loaded: nobody else touched the file, the etag here had gone stale, and
 * one retry against the disk's version is safe.
 */
export function isOwnVersion(
	disk: Version,
	known: ReadonlySet<string>,
	sent: readonly string[],
): boolean {
	return known.has(disk.etag) || sent.includes(disk.text);
}

export function useFileBuffer({
	workspaceId,
	projectId,
	path,
	settings,
	onUnsavedChange,
}: {
	workspaceId: string;
	projectId: string;
	path: string;
	settings: EditorSettings;
	onUnsavedChange?: (unsaved: boolean) => void;
}) {
	const file = useFile(workspaceId, projectId, path);
	const save = useSaveFile(workspaceId, projectId, path);
	const [state, dispatch] = useReducer(bufferReducer, INITIAL_BUFFER);
	const { text, etag, dirty, status, conflict, deleted } = state;

	// The tab strip shows a dot while the file has edits not on disk; a closed
	// tab reports clean so it leaves nothing behind.
	const reportUnsaved = useRef(onUnsavedChange);
	reportUnsaved.current = onUnsavedChange;
	const unsaved = status === "unsaved" || status === "saving";
	useEffect(() => {
		reportUnsaved.current?.(unsaved);
	}, [unsaved]);
	useEffect(() => {
		return () => reportUnsaved.current?.(false);
	}, []);

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// True while a write is in flight: a second one would send a stale etag
	// and be refused as a false conflict.
	const writing = useRef(false);
	// Every version this tab has seen, so a refetch that was in flight during
	// a save cannot put older text back.
	const known = useRef(new Set<string>());
	// The last few bodies this tab wrote. Its own write makes the events
	// socket report a change, and that read can beat the write's own answer.
	const sent = useRef<string[]>([]);

	// The save reads the newest text and etag, not the ones captured when the
	// timer was set.
	const latest = useRef({ text, etag, deleted });
	latest.current = { text, etag, deleted };
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
		// Three covers the reads already on their way when this write went out.
		sent.current = [...sent.current.slice(-2), body];
		writing.current = true;
		dispatch({ type: "saveStart" });
		try {
			const result = await save.mutateAsync({ text: body, etag: against });
			known.current.add(result.etag);
			dispatch({ type: "saveDone", etag: result.etag, sent: body });
			if (latest.current.text !== body) {
				// With auto-save off the student asked for this save, so keystrokes
				// that arrived during it go out at once.
				scheduleSave(settingsRef.current.autoSave ? undefined : 0);
			}
		} catch (error) {
			if (error instanceof FileConflictError) {
				// The refusal carries the version on disk but not its text, and the
				// conflict view needs both sides.
				const fresh = await file.refetch();
				const disk = fresh.data;
				const readable = disk !== undefined && !disk.binary && !disk.tooLarge;
				if (!retried && readable && isOwnVersion(disk, known.current, sent.current)) {
					await write(body, disk.etag, true);
					return;
				}
				dispatch({
					type: "conflict",
					version: readable
						? { etag: disk.etag, text: disk.text }
						: { etag: error.etag, text: "" },
				});
				return;
			}
			dispatch({
				type: "saveFailed",
				message: isStorageFull(error)
					? STORAGE_FULL_SAVE_MESSAGE
					: error instanceof Error
						? error.message
						: "The save failed.",
			});
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
			// about to replace.
			if (writing.current) {
				scheduleSave(delayMs);
				return;
			}
			const current = latest.current;
			if (current.text === null) return;
			void write(current.text, current.deleted ? null : current.etag);
		}, delayMs);
	}

	function edit(next: string, inConflictView: boolean) {
		dispatch({ type: "edit", text: next, inConflictView });
		// An unresolved conflict waits; autosaving would only produce another 412.
		if (conflict !== null) return;
		// With auto-save off the text waits for Ctrl+S (SPEC.md §13.5).
		if (settingsRef.current.autoSave) scheduleSave();
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

	const data = file.data;
	useEffect(() => {
		if (!data || data.binary || data.tooLarge) return;
		if (known.current.has(data.etag)) return;
		const own = sent.current.includes(data.text);
		// A conflicting read stays unknown so it is offered again after a resolve.
		if (own || !(text !== null && dirty)) known.current.add(data.etag);
		dispatch({
			type: "read",
			version: { etag: data.etag, text: data.text },
			own,
			writing: writing.current,
		});
	}, [data, text, dirty]);

	// A read that fails once the file is open keeps the editor: the student's
	// text is the only copy of their work (SPEC.md §13.3).
	const readError = file.error;
	const gone = readError instanceof ApiError && readError.status === 404;
	useEffect(() => {
		if (gone) dispatch({ type: "deleted" });
	}, [gone]);

	async function takeDisk() {
		cancelTimer();
		const fresh = await file.refetch();
		if (!fresh.data) return;
		known.current.add(fresh.data.etag);
		dispatch({
			type: "takeDisk",
			version: { etag: fresh.data.etag, text: fresh.data.text },
		});
	}

	function keepMine() {
		cancelTimer();
		const current = latest.current;
		if (current.text === null || conflict === null) return;
		dispatch({ type: "keepMine" });
		void write(current.text, conflict.etag);
	}

	return {
		state,
		file,
		readError,
		gone,
		onChange: (next: string) => edit(next, false),
		onConflictChange: (next: string) => edit(next, true),
		saveNow,
		takeDisk,
		keepMine,
		toggleConflict: () => dispatch({ type: "toggleConflict" }),
	};
}
