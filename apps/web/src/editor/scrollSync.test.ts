import type * as Monaco from "monaco-editor";
import { expect, test } from "vitest";
import {
	type Block,
	editorScrollTop,
	editorTopLine,
	lineForTop,
	topForLine,
} from "./scrollSync.js";

// A short document: a heading on line 1, a paragraph on line 3, a code block
// on line 11, and a closing paragraph on line 21.
const BLOCKS: Block[] = [
	{ line: 1, top: 0 },
	{ line: 3, top: 100 },
	{ line: 11, top: 200 },
	{ line: 21, top: 900 },
];

test("a line that starts a block scrolls that block to the top", () => {
	expect(topForLine(BLOCKS, 1)).toBe(0);
	expect(topForLine(BLOCKS, 3)).toBe(100);
	expect(topForLine(BLOCKS, 11)).toBe(200);
	expect(topForLine(BLOCKS, 21)).toBe(900);
});

test("a line inside a block is interpolated towards the next one", () => {
	// Halfway from line 1 to line 3 is halfway from 0 to 100.
	expect(topForLine(BLOCKS, 2)).toBe(50);
	// A long code block moves in small steps, not in one jump.
	expect(topForLine(BLOCKS, 16)).toBeCloseTo(550);
});

test("a line past the last block stays on that block", () => {
	expect(topForLine(BLOCKS, 500)).toBe(900);
});

test("a line before the first block, or no blocks at all, is the top", () => {
	expect(topForLine([{ line: 5, top: 40 }], 1)).toBe(0);
	expect(topForLine([], 7)).toBe(0);
});

test("the top of the preview reads back as the line it came from", () => {
	expect(lineForTop(BLOCKS, 0)).toBe(1);
	expect(lineForTop(BLOCKS, 100)).toBe(3);
	expect(lineForTop(BLOCKS, 200)).toBe(11);
	expect(lineForTop(BLOCKS, 900)).toBe(21);
});

test("a position between two blocks is interpolated as a fraction of a line", () => {
	expect(lineForTop(BLOCKS, 50)).toBe(2);
	expect(lineForTop(BLOCKS, 550)).toBe(16);
	// A quarter of the way through the paragraph block is half a line in,
	// so a scroll inside one long wrapped line still moves the editor.
	expect(lineForTop(BLOCKS, 25)).toBeCloseTo(1.5);
	expect(lineForTop(BLOCKS, 210)).toBeCloseTo(11 + 10 / 70);
});

test("a position past the end stays on the last block's line", () => {
	expect(lineForTop(BLOCKS, 5000)).toBe(21);
});

test("nothing rendered, or nothing scrolled, is line one", () => {
	expect(lineForTop([], 300)).toBe(1);
	expect(lineForTop([{ line: 4, top: 40 }], 0)).toBe(4);
});

test("a line and its offset turn back into each other", () => {
	const top = topForLine(BLOCKS, 13);
	expect(lineForTop(BLOCKS, top)).toBe(13);
});

// A fake editor of six lines, 20 pixels each, except line 3, which is
// wrapped over five rows and so is 100 pixels tall.
function fakeEditor(scrollTop: number, lineCount = 6): Monaco.editor.ICodeEditor {
	const topFor = (line: number) => {
		let top = 0;
		for (let n = 1; n < line; n += 1) top += n === 3 ? 100 : 20;
		return top;
	};
	const firstVisible = () => {
		let line = 1;
		while (line < lineCount && topFor(line + 1) <= scrollTop) line += 1;
		return line;
	};
	return {
		getScrollTop: () => scrollTop,
		getTopForLineNumber: topFor,
		getBottomForLineNumber: (line: number) => topFor(line + 1),
		getVisibleRanges: () =>
			lineCount === 0 ? [] : [{ startLineNumber: firstVisible() }],
		getModel: () => (lineCount === 0 ? null : { getLineCount: () => lineCount }),
	} as unknown as Monaco.editor.ICodeEditor;
}

test("the editor's top line is whole at a line boundary", () => {
	expect(editorTopLine(fakeEditor(0))).toBe(1);
	expect(editorTopLine(fakeEditor(40))).toBe(3);
	expect(editorTopLine(fakeEditor(140))).toBe(4);
});

test("scrolling inside a wrapped line reports a fraction of that line", () => {
	expect(editorTopLine(fakeEditor(90))).toBeCloseTo(3.5);
	expect(editorTopLine(fakeEditor(50))).toBeCloseTo(3.1);
});

test("the top line never reaches the next whole line or falls below the first", () => {
	expect(editorTopLine(fakeEditor(139))).toBeLessThan(4);
	expect(editorTopLine(fakeEditor(139))).toBeGreaterThan(3.9);
	expect(editorTopLine(fakeEditor(0, 0))).toBe(1);
});

test("a fractional line turns into a scroll offset inside the wrapped line", () => {
	const editor = fakeEditor(0);
	expect(editorScrollTop(editor, 3)).toBe(40);
	expect(editorScrollTop(editor, 3.5)).toBe(90);
	expect(editorScrollTop(editor, 4)).toBe(140);
	expect(editorScrollTop(editor, 1.25)).toBe(5);
});

test("a line past the end or before the start is clamped", () => {
	const editor = fakeEditor(0);
	expect(editorScrollTop(editor, 0)).toBe(0);
	expect(editorScrollTop(editor, 99)).toBe(editorScrollTop(editor, 7));
	expect(editorScrollTop(editor, 99)).toBe(200);
});

test("the editor's top line and its offset turn back into each other", () => {
	for (const scrollTop of [0, 30, 90, 139, 150]) {
		const line = editorTopLine(fakeEditor(scrollTop));
		expect(editorScrollTop(fakeEditor(0), line)).toBeCloseTo(scrollTop, 3);
	}
});
