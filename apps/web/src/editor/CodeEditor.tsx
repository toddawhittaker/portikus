/**
 * The Monaco editor for one open file (SPEC.md §13.1, §13.5). It owns the
 * editor instance and its model; the tab above owns the text, the etag and
 * the saving.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { currentThemeName, getMonaco } from "./monaco.js";
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
	readOnly?: boolean;
	onChange: (text: string) => void;
	onSave: () => void;
	/** Jump here when the editor opens, for "open at line" (SPEC.md §15.3). */
	revealLine?: number;
}

/** The language id whose extension or file name matches this path. */
export function languageForPath(monaco: typeof Monaco, path: string): string {
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
	readOnly,
	onChange,
	onSave,
	revealLine,
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
	const latest = useRef({ value, onChange, onSave, revealLine });
	latest.current = { value, onChange, onSave, revealLine };

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

	// A refreshed file replaces the text through an edit operation, so the undo
	// stack, the cursor and the scroll position survive (SPEC.md §13.3).
	useEffect(() => {
		const model = modelRef.current;
		if (!model || applied.current === version) return;
		applied.current = version;
		if (model.getValue() === value) return;
		applying.current = true;
		try {
			model.pushEditOperations(
				[],
				[{ range: model.getFullModelRange(), text: value }],
				() => null,
			);
		} finally {
			applying.current = false;
		}
	}, [value, version]);

	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: readOnly ?? false });
	}, [readOnly]);

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

	// The theme follows the page's choice (shell/theme.ts).
	useEffect(() => {
		function apply() {
			void getMonaco().then((monaco) => monaco.editor.setTheme(currentThemeName()));
		}
		const observer = new MutationObserver(apply);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		const media = matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", apply);
		return () => {
			observer.disconnect();
			media.removeEventListener("change", apply);
		};
	}, []);

	return <div className="pk-editor" data-testid={`editor-${path}`} ref={host} />;
}
