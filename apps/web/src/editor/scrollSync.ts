/**
 * Keeping the two sides of the Markdown split view on the same line
 * (SPEC.md §13.4). The rule is the top visible line: whatever line is first
 * on the left is first on the right, in the preview and in the diff alike.
 *
 * The preview is matched through the `data-line` attribute the renderer puts
 * on every block it draws, so a long code block cannot drift away from the
 * heading it belongs to the way a plain ratio did.
 */

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
 * The inverse of `topForLine`, rounded to a whole line because that is what
 * the editor can be scrolled to.
 */
export function lineForTop(blocks: Block[], scrollTop: number): number {
	if (blocks.length === 0) return 1;
	const index = lastAtOrBefore(blocks, (block) => block.top <= scrollTop);
	if (index < 0) return blocks[0]?.line ?? 1;
	const block = blocks[index] as Block;
	const next = blocks[index + 1];
	if (!next || next.top <= block.top) return block.line;
	const fraction = (scrollTop - block.top) / (next.top - block.top);
	return Math.round(block.line + fraction * (next.line - block.line));
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
