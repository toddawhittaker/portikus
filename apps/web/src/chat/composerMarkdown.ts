/**
 * The composer's document as the Markdown text it sends (SPEC.md §10.8).
 * Only what the composer's schema holds is written: paragraphs, bold,
 * italic, code spans, code blocks and lists. Text is never escaped, so a
 * literal `*` or `_` the student typed goes out exactly as typed; lines of
 * text are joined by one newline, as a textarea would send them.
 */
import type { Fragment, Mark, Node } from "@tiptap/pm/model";

/** Opening and closing order: emphasis outside, code innermost. */
const MARKS: Record<string, string> = { bold: "**", italic: "*" };

export function toMarkdown(content: Fragment): string {
	return blockLines(content, false).join("\n");
}

/**
 * Lines for a run of blocks. Consecutive paragraphs are consecutive lines;
 * a list or code block is set off by a blank line at the top level so it
 * does not run into its neighbour. Inside a list item nothing is set off,
 * which keeps the list tight.
 */
function blockLines(content: Fragment, inItem: boolean): string[] {
	const lines: string[] = [];
	let previous: Node | null = null;
	content.forEach((node) => {
		if (
			previous &&
			!inItem &&
			(previous.type.name !== "paragraph" || node.type.name !== "paragraph")
		) {
			lines.push("");
		}
		lines.push(...nodeLines(node));
		previous = node;
	});
	return lines;
}

function nodeLines(node: Node): string[] {
	switch (node.type.name) {
		case "codeBlock": {
			const fence = "`".repeat(Math.max(3, longestRun(node.textContent, "`") + 1));
			const language = (node.attrs.language as string | null) ?? "";
			return [fence + language, ...node.textContent.split("\n"), fence];
		}
		case "bulletList":
		case "orderedList": {
			const start = (node.attrs.start as number | undefined) ?? 1;
			const lines: string[] = [];
			node.forEach((item, _offset, index) => {
				const marker = node.type.name === "bulletList" ? "- " : `${start + index}. `;
				const pad = " ".repeat(marker.length);
				blockLines(item.content, true).forEach((line, at) => {
					lines.push(at === 0 ? marker + line : line === "" ? "" : pad + line);
				});
			});
			return lines;
		}
		default:
			return node.isTextblock
				? inline(node).split("\n")
				: blockLines(node.content, false);
	}
}

/** A textblock's text with its marks written as Markdown markers. */
function inline(block: Node): string {
	let out = "";
	let open: Mark[] = [];

	const close = (keep: number) => {
		if (open.length <= keep) return;
		// A closing marker hugs the text, so trailing spaces move outside it.
		const trail = /\s*$/.exec(out)?.[0] ?? "";
		out = out.slice(0, out.length - trail.length);
		for (const mark of open.slice(keep).reverse()) out += MARKS[mark.type.name] ?? "";
		out += trail;
		open = open.slice(0, keep);
	};

	block.forEach((child) => {
		const text = child.text ?? "";
		const code = child.marks.some((mark) => mark.type.name === "code");
		const marks = child.marks.filter((mark) => mark.type.name in MARKS);
		let keep = 0;
		while (
			keep < open.length &&
			keep < marks.length &&
			open[keep]?.eq(marks[keep] as Mark)
		) {
			keep += 1;
		}
		close(keep);
		let body = code ? codeSpan(text) : text;
		const opening = marks.slice(keep);
		if (opening.length > 0) {
			// An opening marker hugs the text, so leading spaces stay outside it.
			const lead = /^\s*/.exec(body)?.[0] ?? "";
			out += lead;
			body = body.slice(lead.length);
			for (const mark of opening) out += MARKS[mark.type.name] ?? "";
			open = [...open, ...opening];
		}
		out += body;
	});
	close(0);
	return out;
}

/** A code span fenced with more backticks than the text holds in a row. */
function codeSpan(text: string): string {
	const fence = "`".repeat(longestRun(text, "`") + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

function longestRun(text: string, char: string): number {
	let longest = 0;
	let run = 0;
	for (const c of text) {
		run = c === char ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}
