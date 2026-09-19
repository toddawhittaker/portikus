/**
 * Keeping the two sides of the Markdown split view on the same line
 * (SPEC.md §13.4). The rule is the top visible line: whatever line is first
 * on the left is first on the right, in the preview and in the diff alike.
 *
 * The preview is matched through the `data-line` attribute the renderer puts
 * on every block it draws, so a long code block cannot drift away from the
 * heading it belongs to the way a plain ratio did.
 *
 * Lines here are fractional: 12.5 means half a line further down than line 12.
 * With word wrap on, one source line can fill the whole viewport, so whole
 * lines would leave one side standing still and then jumping.
 */
import type * as Monaco from "monaco-editor";

/** One rendered block: the source line it came from and where it sits. */
export interface Block {
	/** The 1-based source line the block starts on. */
	line: number;
	/** The block's offset from the top of the scrollable content, in pixels. */
	top: number;
}

/**
 * Where to scroll the preview so that the given source line is at the top.
 * Between two blocks the answer is interpolated, so scrolling through a long
 * paragraph moves the preview a little rather than not at all.
 */
export function topForLine(blocks: Block[], line: number): number {
	if (blocks.length === 0) return 0;
	const index = lastAtOrBefore(blocks, (block) => block.line <= line);
	if (index < 0) return 0;
	const block = blocks[index] as Block;
	const next = blocks[index + 1];
	if (!next || next.line <= block.line) return block.top;
	const fraction = (line - block.line) / (next.line - block.line);
	return block.top + fraction * (next.top - block.top);
}

/**
 * The source line at the top of the preview, given where it is scrolled to.
 * The inverse of `topForLine`. The answer is fractional, so a scroll inside
 * one long paragraph still moves the editor.
 */
export function lineForTop(blocks: Block[], scrollTop: number): number {
	if (blocks.length === 0) return 1;
	const index = lastAtOrBefore(blocks, (block) => block.top <= scrollTop);
	if (index < 0) return blocks[0]?.line ?? 1;
	const block = blocks[index] as Block;
	const next = blocks[index + 1];
	if (!next || next.top <= block.top) return block.line;
	const fraction = (scrollTop - block.top) / (next.top - block.top);
	return block.line + fraction * (next.line - block.line);
}

/** The last block the test holds for; blocks are in document order. */
function lastAtOrBefore(blocks: Block[], holds: (block: Block) => boolean): number {
	let found = -1;
	for (let index = 0; index < blocks.length; index += 1) {
		if (!holds(blocks[index] as Block)) break;
		found = index;
	}
	return found;
}

/** Read the rendered blocks out of the preview, top to bottom. */
export function readBlocks(container: HTMLElement): Block[] {
	const base = container.getBoundingClientRect().top - container.scrollTop;
	const blocks: Block[] = [];
	for (const node of container.querySelectorAll<HTMLElement>("[data-line]")) {
		const line = Number.parseInt(node.dataset.line ?? "", 10);
		if (!Number.isFinite(line)) continue;
		const top = node.getBoundingClientRect().top - base;
		// A nested block can start on the same line as its parent; the first
		// one wins, because it is the one whose top the parent shares.
		const previous = blocks[blocks.length - 1];
		if (previous && previous.line === line) continue;
		blocks.push({ line, top });
	}
	return blocks;
}

/**
 * The first line a Monaco editor is showing, as a fraction of a source line.
 */
export function editorTopLine(editor: Monaco.editor.ICodeEditor): number {
	const visible = editor.getVisibleRanges()[0];
	if (!visible) return 1;
	const first = visible.startLineNumber;
	const above = editor.getTopForLineNumber(first);
	const below = bottomOfLine(editor, first);
	if (below <= above) return first;
	const fraction = (editor.getScrollTop() - above) / (below - above);
	return first + Math.min(Math.max(fraction, 0), 0.999999);
}

/** Where a Monaco editor must be scrolled to put a fractional line at the top. */
export function editorScrollTop(
	editor: Monaco.editor.ICodeEditor,
	line: number,
): number {
	const lines = editor.getModel()?.getLineCount() ?? 1;
	const whole = Math.min(Math.max(Math.floor(line), 1), lines);
	const above = editor.getTopForLineNumber(whole);
	const below = bottomOfLine(editor, whole);
	const fraction = Math.min(Math.max(line - whole, 0), 1);
	return above + fraction * Math.max(below - above, 0);
}

/** The offset of the line after this one, or this line's bottom at the end. */
function bottomOfLine(editor: Monaco.editor.ICodeEditor, line: number): number {
	const lines = editor.getModel()?.getLineCount() ?? line;
	if (line >= lines) return editor.getBottomForLineNumber(line);
	return editor.getTopForLineNumber(line + 1);
}
