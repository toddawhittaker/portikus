/**
 * The Monaco editor for one open file (SPEC.md §13.1, §13.5). It owns the
 * editor instance and its model; the tab above owns the text, the etag and
 * the saving.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import {
	baseEditorOptions,
	currentThemeName,
	getMonaco,
	languageForFile,
	watchTheme,
} from "./monaco.js";
import { DEFAULT_ZOOM, fontSizeFor, stepZoom } from "./zoom.js";
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
	/** From the student's editor settings (issue #159). */
	wordWrap?: "on" | "off";
	/** Jump here when the editor opens, for "open at line" (SPEC.md §15.3). */
	revealLine?: number;
	/**
	 * Changes every time the same tab is asked to jump again, so reopening a
	 * file at a line it is already showing still moves the cursor there.
	 */
	revealNonce?: number;
}

export function CodeEditor({
	path,
	value,
	version,
	onChange,
	onSave,
	wordWrap = "off",
	revealLine,
	revealNonce,
}: CodeEditorProps) {
	const host = useRef<HTMLDivElement | null>(null);
	// The whole tab: Monaco above, the zoom bar below.
	const container = useRef<HTMLDivElement | null>(null);
	// Zoom is per open editor and lasts for this session only (SPEC.md §13.1).
	const [zoom, setZoom] = useState(DEFAULT_ZOOM);
	// Shown on the bar under the editor, so the guessed language is visible.
	const [language, setLanguage] = useState("plaintext");
	// The editor and the wheel handler are set up once, so they read the newest
	// zoom through a ref rather than being rebuilt on every step.
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	// Same reason: the editor is created once, so it reads the newest wrap
	// setting here and through the effect below.
	const wrapRef = useRef(wordWrap);
	wrapRef.current = wordWrap;
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
					languageForFile(monaco, path, firstLineOf(latest.current.value)),
					uri,
				);
			const editor = monaco.editor.create(host.current, {
				...baseEditorOptions,
				model,
				theme: currentThemeName(),
				renderLineHighlight: "line",
				fontSize: fontSizeFor(zoomRef.current),
				wordWrap: wrapRef.current,
			});
			// Editor-only zoom by keyboard (SPEC.md §13.1). Monaco swallows these
			// keys, so the browser's own zoom does not also fire.
			const mod = monaco.KeyMod.CtrlCmd;
			editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.Equal, () => {
				setZoom((current) => stepZoom(current, 1));
			});
			editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => {
				setZoom((current) => stepZoom(current, -1));
			});
			editor.addCommand(mod | monaco.KeyCode.Digit0, () => {
				setZoom(DEFAULT_ZOOM);
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
			// The first line may only be known now, so the guessed language is
			// settled once the model holds the real text (SPEC.md §13.2).
			const settled = languageForFile(monaco, path, firstLineOf(model.getValue()));
			monaco.editor.setModelLanguage(model, settled);
			setLanguage(settled);
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

	useEffect(() => {
		editorRef.current?.updateOptions({ fontSize: fontSizeFor(zoom) });
	}, [zoom]);

	// Word wrap comes from the student's settings (issue #159, SPEC.md §13.1).
	useEffect(() => {
		editorRef.current?.updateOptions({ wordWrap });
	}, [wordWrap]);

	// Ctrl + wheel zooms the editor only. preventDefault stops the browser from
	// zooming the whole page, so the listener cannot be passive (SPEC.md §13.1).
	useEffect(() => {
		const node = host.current;
		if (!node) return;
		function onWheel(event: WheelEvent) {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			if (event.deltaY === 0) return;
			setZoom(stepZoom(zoomRef.current, event.deltaY < 0 ? 1 : -1));
		}
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, []);

	// Ctrl/Cmd+S saves now instead of opening the browser's save dialog
	// (SPEC.md §13.5). It is a listener rather than a JSX handler because the
	// keys arrive on Monaco's own elements inside this host.
	useEffect(() => {
		const node = container.current;
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

	return (
		<div className="pk-editor" data-testid={`editor-${path}`} ref={container}>
			<div className="pk-editor-host" ref={host} />
			<div className="pk-editor-bar">
				<span className="pk-editor-language" data-testid={`editor-language-${path}`}>
					{language}
				</span>
				<button
					type="button"
					className="pk-zoom-button"
					aria-label="Zoom out"
					onClick={() => setZoom(stepZoom(zoom, -1))}
				>
					&minus;
				</button>
				<span className="pk-zoom-value" data-testid={`editor-zoom-${path}`}>
					{zoom}%
				</span>
				<button
					type="button"
					className="pk-zoom-button"
					aria-label="Zoom in"
					onClick={() => setZoom(stepZoom(zoom, 1))}
				>
					+
				</button>
				<button
					type="button"
					className="pk-zoom-reset"
					onClick={() => setZoom(DEFAULT_ZOOM)}
				>
					Reset
				</button>
			</div>
		</div>
	);
}

/** The first line of a file, for guessing its language. */
function firstLineOf(text: string): string {
	const end = text.indexOf("\n");
	return (end < 0 ? text : text.slice(0, end)).slice(0, 200);
}
