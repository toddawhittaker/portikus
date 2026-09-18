/**
 * The Monaco diff editor for one changed file (SPEC.md §12.6). It owns the
 * editor and its two models; the tab above owns the fetching and decides
 * what the two sides hold.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import {
	baseEditorOptions,
	currentThemeName,
	getMonaco,
	languageForPath,
	watchTheme,
} from "./monaco.js";
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
}

export function DiffViewer({ path, original, modified, version }: DiffViewerProps) {
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
	const latest = useRef({ original, modified, version });
	latest.current = { original, modified, version };

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
				// Both sides are a view of what is on disk, never an edit surface
				// (SPEC.md §12.6): staging and committing are the student's own
				// Git commands.
				readOnly: true,
				originalEditable: false,
				renderSideBySide: true,
			});
			editor.setModel(models);
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

	// The theme follows the page's choice; one watcher serves every editor.
	useEffect(() => {
		watchTheme();
	}, []);

	return <div className="pk-editor" data-testid={`diff-editor-${path}`} ref={host} />;
}
