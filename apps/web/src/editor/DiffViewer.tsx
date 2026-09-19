/**
 * The Monaco diff editor for one changed file (SPEC.md §12.6). It owns the
 * editor and its two models; the tab above owns the fetching and decides
 * what the two sides hold.
 */
import type * as Monaco from "monaco-editor";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import {
	baseEditorOptions,
	currentThemeName,
	getMonaco,
	languageForPath,
	watchTheme,
} from "./monaco.js";
import { editorScrollTop, editorTopLine } from "./scrollSync.js";
import "./editor.css";

export interface DiffViewerProps {
	/** The project-relative path of the working-tree side; it picks the language. */
	path: string;
	/** The HEAD side. Empty for a file that is not in HEAD. */
	original: string;
	/** The working-tree side. Empty for a file that was deleted. */
	modified: string;
	/**
	 * Which version of the diff the two sides are. The editor only replaces
	 * its text when this changes, so a re-render cannot undo a live refresh.
	 */
	version: string;
	/**
	 * Let the student type on the working-copy side. Used by the conflict
	 * view, where the right side is their own unsaved text (issue #158).
	 */
	editable?: boolean;
	/** Every keystroke on the working-copy side, when it is editable. */
	onChange?: (value: string) => void;
	/** The test id of the host element; the conflict view sets its own. */
	testId?: string;
	/**
	 * Reports the first line the working-copy side is showing, so a Markdown
	 * tab can keep its raw text on the same line (issue #229).
	 */
	onTopLine?: (line: number) => void;
	/** Lets the tab scroll the working-copy side to a line. */
	ref?: Ref<DiffEditorHandle>;
}

export interface DiffEditorHandle {
	/** Scroll the working-copy side so this line is the first one showing. */
	setTopLine: (line: number) => void;
}

export function DiffViewer({
	path,
	original,
	modified,
	version,
	editable = false,
	onChange,
	testId,
	onTopLine,
	ref,
}: DiffViewerProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
	const modelsRef = useRef<{
		original: Monaco.editor.ITextModel;
		modified: Monaco.editor.ITextModel;
	} | null>(null);
	// The version whose text the models already hold.
	const applied = useRef<string | null>(null);

	// The editor is created once, so it reads the newest text through a ref
	// rather than being torn down on every render.
	const latest = useRef({ original, modified, version, onTopLine });
	latest.current = { original, modified, version, onTopLine };
	// The callback can change on every render; the listener reads it here.
	const change = useRef(onChange);
	change.current = onChange;
	// Whether the editor was built editable. No tab changes its mind while it
	// is open, so this is read once, when the editor is created.
	const editableRef = useRef(editable);

	useEffect(() => {
		let disposed = false;
		void getMonaco().then((monaco) => {
			if (disposed || !host.current) return;
			const language = languageForPath(monaco, path);
			const models = {
				original: monaco.editor.createModel(latest.current.original, language),
				modified: monaco.editor.createModel(latest.current.modified, language),
			};
			const editor = monaco.editor.createDiffEditor(host.current, {
				...baseEditorOptions,
				theme: currentThemeName(),
				// A plain diff is a view of what is on disk, never an edit
				// surface (SPEC.md §12.6). The conflict view is the one place
				// the working-copy side is the student's own unsaved text.
				readOnly: !editableRef.current,
				originalEditable: false,
				// Monaco falls back to its inline layout below 900px, which the
				// right pane of a Markdown split always is. That layout prints
				// two line-number columns and adds an overview ruler next to
				// the scrollbar, so the pane looked doubled. Stay side by side
				// at every width and keep the one scrollbar; the change marks
				// in the gutter and the minimap still show where the edits are.
				renderSideBySide: true,
				useInlineViewWhenSpaceIsLimited: false,
				renderOverviewRuler: false,
			});
			editor.setModel(models);
			if (editableRef.current) {
				models.modified.onDidChangeContent(() => {
					change.current?.(models.modified.getValue());
				});
			}
			editor.getModifiedEditor().onDidScrollChange(() => {
				latest.current.onTopLine?.(editorTopLine(editor.getModifiedEditor()));
			});
			editorRef.current = editor;
			modelsRef.current = models;
			applied.current = latest.current.version;
		});
		return () => {
			disposed = true;
			editorRef.current?.dispose();
			modelsRef.current?.original.dispose();
			modelsRef.current?.modified.dispose();
			editorRef.current = null;
			modelsRef.current = null;
			applied.current = null;
		};
	}, [path]);

	// A refreshed diff keeps the place the student had scrolled to, so a live
	// update does not lose their review context (SPEC.md §12.6).
	useEffect(() => {
		const editor = editorRef.current;
		const models = modelsRef.current;
		if (!editor || !models || applied.current === version) return;
		applied.current = version;
		const view = editor.saveViewState();
		if (models.original.getValue() !== original) {
			models.original.setValue(original);
		}
		if (models.modified.getValue() !== modified) {
			models.modified.setValue(modified);
		}
		if (view) editor.restoreViewState(view);
	}, [original, modified, version]);

	useImperativeHandle(ref, () => ({
		setTopLine(line: number) {
			const modified = editorRef.current?.getModifiedEditor();
			if (!modified) return;
			modified.setScrollTop(editorScrollTop(modified, line));
		},
	}));

	// The theme follows the page's choice; one watcher serves every editor.
	useEffect(() => {
		watchTheme();
	}, []);

	return (
		<div
			className="pk-editor"
			data-testid={testId ?? `diff-editor-${path}`}
			ref={host}
		/>
	);
}
