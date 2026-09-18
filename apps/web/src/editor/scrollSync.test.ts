import { expect, test } from "vitest";
import { type Block, lineForTop, topForLine } from "./scrollSync.js";

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

test("a position between two blocks is interpolated, in whole lines", () => {
	expect(lineForTop(BLOCKS, 50)).toBe(2);
	expect(lineForTop(BLOCKS, 550)).toBe(16);
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
