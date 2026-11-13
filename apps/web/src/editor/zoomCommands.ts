import type * as Monaco from "monaco-editor";
import { DEFAULT_ZOOM, stepZoom } from "./zoom.js";

/**
 * Editor-only zoom by keyboard (SPEC.md §13.1). Monaco swallows these keys,
 * so the browser's own zoom does not also fire. `current` and `set` are read
 * when a key is pressed, because the editor is built once.
 */
export function addZoomCommands(
	monaco: typeof Monaco,
	editor: Monaco.editor.IStandaloneCodeEditor,
	current: () => number,
	set: (percent: number) => void,
): void {
	const mod = monaco.KeyMod.CtrlCmd;
	editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.Equal, () => {
		set(stepZoom(current(), 1));
	});
	editor.addCommand(mod | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => {
		set(stepZoom(current(), -1));
	});
	editor.addCommand(mod | monaco.KeyCode.Digit0, () => {
		set(DEFAULT_ZOOM);
	});
}
