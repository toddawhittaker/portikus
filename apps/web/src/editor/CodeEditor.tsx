/**
 * The Monaco editor for one open file (SPEC.md §13.1, §13.5). It owns the
 * editor instance and its model; the tab above owns the text, the etag and
 * the saving.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { currentThemeName, getMonaco, watchTheme } from "./monaco.js";
import "./editor.css";

export interface CodeEditorProps {
	/** The project-relative path; it names the model and picks the language. */
	path: string;
	value: string;
	/**
	 * Which version of the file `value` is. The editor only replaces its text
	 * when this changes, so a render that lags behind the keystrokes cannot
	 * put older text back.
	 */
	version: string;
	onChange: (text: string) => void;
	onSave: () => void;
	/** Jump here when the editor opens, for "open at line" (SPEC.md §15.3). */
	revealLine?: number;
	/**
	 * Changes every time the same tab is asked to jump again, so reopening a
	 * file at a line it is already showing still moves the cursor there.
	 */
	revealNonce?: number;
}

/** The language id whose extension or file name matches this path. */
function languageForPath(monaco: typeof Monaco, path: string): string {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot) : "";
	for (const language of monaco.languages.getLanguages()) {
		if (language.filenames?.includes(name)) return language.id;
	}
	if (extension === "") return "plaintext";
	for (const language of monaco.languages.getLanguages()) {
		if (language.extensions?.includes(extension)) return language.id;
	}
	return "plaintext";
}

export function CodeEditor({
	path,
	value,
	version,
	onChange,
	onSave,
	revealLine,
	revealNonce,
}: CodeEditorProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
	// True while an external refresh is being applied, so that edit is not
	// reported back as if the student had typed it.
	const applying = useRef(false);
	// The version whose text the model already holds.
	const applied = useRef<string | null>(null);

	// The editor is created once, so it reads the newest callbacks and text
	// through refs rather than being torn down on every render.
	const latest = useRef({ value, version, onChange, onSave, revealLine });
	latest.current = { value, version, onChange, onSave, revealLine };

	// A later request to jump, once the editor is already up. The one that
	// arrives before Monaco has loaded is handled where the editor is created.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one jump per request
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || revealLine === undefined) return;
		editor.setPosition({ lineNumber: revealLine, column: 1 });
		editor.revealLineInCenter(revealLine);
		editor.focus();
	}, [revealNonce]);

	useEffect(() => {
		let disposed = false;
		void getMonaco().then((monaco) => {
			if (disposed || !host.current) return;
			const uri = monaco.Uri.parse(`pk:/${path}`);
			const model =
				monaco.editor.getModel(uri) ??
				monaco.editor.createModel(
					latest.current.value,
					languageForPath(monaco, path),
					uri,
				);
			const editor = monaco.editor.create(host.current, {
				model,
				theme: currentThemeName(),
				automaticLayout: true,
				fontFamily: '"JetBrains Mono", ui-monospace, monospace',
				fontSize: 13,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				renderLineHighlight: "line",
			});
			editorRef.current = editor;
			modelRef.current = model;
			// Monaco loads after the first renders, so the model starts from the
			// newest text, not from the `value` of the render that set it up.
			if (model.getValue() !== latest.current.value) {
				applying.current = true;
				try {
					model.applyEdits([
						{ range: model.getFullModelRange(), text: latest.current.value },
					]);
				} finally {
					applying.current = false;
				}
			}
			applied.current = latest.current.version;
			editor.onDidChangeModelContent(() => {
				if (applying.current) return;
				latest.current.onChange(model.getValue());
			});
			const line = latest.current.revealLine;
			if (line !== undefined) {
				editor.setPosition({ lineNumber: line, column: 1 });
				editor.revealLineInCenter(line);
			}
		});
		return () => {
			disposed = true;
			editorRef.current?.dispose();
			modelRef.current?.dispose();
			editorRef.current = null;
			modelRef.current = null;
		};
	}, [path]);

	// A refreshed file replaces the text through an edit operation, so the
	// cursor and the scroll position survive (SPEC.md §13.3).
	useEffect(() => {
		const model = modelRef.current;
		if (!model || applied.current === version) return;
		applied.current = version;
		if (model.getValue() === value) return;
		applying.current = true;
		try {
			// applyEdits, not pushEditOperations: an external refresh must not
			// enter the undo stack, or Ctrl+Z would bring stale text back and
			// the next save would write it over the newer file (SPEC.md §13.3).
			model.applyEdits([{ range: model.getFullModelRange(), text: value }]);
		} finally {
			applying.current = false;
		}
	}, [value, version]);

	// Ctrl/Cmd+S saves now instead of opening the browser's save dialog
	// (SPEC.md §13.5). It is a listener rather than a JSX handler because the
	// keys arrive on Monaco's own elements inside this host.
	useEffect(() => {
		const node = host.current;
		if (!node) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key.toLowerCase() !== "s") return;
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			latest.current.onSave();
		}
		node.addEventListener("keydown", onKeyDown);
		return () => node.removeEventListener("keydown", onKeyDown);
	}, []);

	// The theme follows the page's choice (shell/theme.ts). One watcher serves
	// every editor on the page, so this only makes sure it is running.
	useEffect(() => {
		watchTheme();
	}, []);

	return <div className="pk-editor" data-testid={`editor-${path}`} ref={host} />;
}
