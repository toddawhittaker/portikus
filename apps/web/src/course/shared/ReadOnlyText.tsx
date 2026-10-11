/**
 * A file's text in a read-only Monaco editor, for the shared project view
 * (SPEC.md §5.2). The student's CodeEditor is built around saving, so this
 * is a separate, smaller piece rather than a flag on that one.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import {
	accessibilitySupport,
	baseEditorOptions,
	currentThemeName,
	editorAriaLabel,
	getMonaco,
	languageForFile,
	watchTheme,
} from "../../editor/monaco.js";
import { useScreenReaderMode } from "../../editor/settingsQueries.js";
import "../../editor/editor.css";

export interface ReadOnlyTextProps {
	/** The project-relative path; it picks the language and names the editor. */
	path: string;
	text: string;
}

/** Mount with `key={path}`: the language is chosen once, when the editor opens. */
export function ReadOnlyText({ path, text }: ReadOnlyTextProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const latest = useRef(text);
	latest.current = text;
	const screenReaderMode = useScreenReaderMode();
	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;

	useEffect(() => {
		let disposed = false;
		void getMonaco().then((monaco) => {
			if (disposed || !host.current) return;
			const firstLine = latest.current.split("\n", 1)[0] ?? "";
			const model = monaco.editor.createModel(
				latest.current,
				languageForFile(monaco, path, firstLine),
			);
			editorRef.current = monaco.editor.create(host.current, {
				...baseEditorOptions,
				model,
				theme: currentThemeName(),
				readOnly: true,
				domReadOnly: true,
				accessibilitySupport: accessibilitySupport(screenReaderRef.current),
				ariaLabel: editorAriaLabel("Read-only file", path),
			});
		});
		return () => {
			disposed = true;
			editorRef.current?.getModel()?.dispose();
			editorRef.current?.dispose();
			editorRef.current = null;
		};
	}, [path]);

	// A poll that brings new text keeps the reader's place in the file.
	useEffect(() => {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model || model.getValue() === text) return;
		const view = editor.saveViewState();
		model.setValue(text);
		if (view) editor.restoreViewState(view);
	}, [text]);

	useEffect(() => {
		editorRef.current?.updateOptions({
			accessibilitySupport: accessibilitySupport(screenReaderMode),
		});
	}, [screenReaderMode]);

	useEffect(() => {
		watchTheme();
	}, []);

	return <div className="pk-editor" data-testid={`shared-text-${path}`} ref={host} />;
}
