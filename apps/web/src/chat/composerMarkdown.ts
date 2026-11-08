/**
 * The composer's document as the Markdown text it sends (SPEC.md §10.8).
 * Only what the composer's schema holds is written: paragraphs, headings,
 * quotes, separator lines, bold, italic, strikethrough, links, code spans,
 * code blocks, and bullet, numbered and task lists, nested. Text is never escaped, so a
 * literal `*` or `_` the student typed goes out exactly as typed; lines of
 * text are joined by one newline, as a textarea would send them.
 */
import type { Fragment, Mark, Node } from "@tiptap/pm/model";

/** Markers for each mark; the schema's mark order puts links outside emphasis and code innermost. */
const MARKS: Record<string, { open: string; close: (mark: Mark) => string }> = {
	link: { open: "[", close: (mark) => `](${linkTarget(mark.attrs.href as string)})` },
	bold: { open: "**", close: () => "**" },
	italic: { open: "*", close: () => "*" },
	strike: { open: "~~", close: () => "~~" },
};

/** A target with brackets or spaces is fenced in angle brackets, as CommonMark allows. */
function linkTarget(href: string): string {
	return /[\s()<>]/.test(href) ? `<${href}>` : href;
}

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
		case "heading":
			return [`${"#".repeat(node.attrs.level as number)} ${inline(node)}`];
		case "horizontalRule":
			return ["---"];
		case "blockquote":
			return blockLines(node.content, false).map((line) =>
				line === "" ? ">" : `> ${line}`,
			);
		case "bulletList":
		case "orderedList":
		case "taskList": {
			const start = (node.attrs.start as number | undefined) ?? 1;
			const lines: string[] = [];
			node.forEach((item, _offset, index) => {
				const marker =
					node.type.name === "bulletList"
						? "- "
						: node.type.name === "taskList"
							? `- [${item.attrs.checked ? "x" : " "}] `
							: `${start + index}. `;
				// A task's text, like a bullet's, starts after "- ".
				const pad = " ".repeat(node.type.name === "taskList" ? 2 : marker.length);
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
	/** Where each open mark's text starts in `out`, after its marker. */
	let starts: number[] = [];

	const close = (keep: number) => {
		if (open.length <= keep) return;
		// A closing marker hugs the text, so trailing spaces move outside it.
		const trail = /\s*$/.exec(out)?.[0] ?? "";
		out = out.slice(0, out.length - trail.length);
		for (let at = open.length - 1; at >= keep; at -= 1) {
			const mark = open[at] as Mark;
			const start = starts[at] as number;
			// A link whose text is its address goes out bare, as GFM links it anyway.
			if (mark.type.name === "link" && out.slice(start) === mark.attrs.href) {
				out = out.slice(0, start - 1) + out.slice(start);
				continue;
			}
			out += MARKS[mark.type.name]?.close(mark) ?? "";
		}
		out += trail;
		open = open.slice(0, keep);
		starts = starts.slice(0, keep);
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
			for (const mark of opening) {
				out += MARKS[mark.type.name]?.open ?? "";
				starts.push(out.length);
			}
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
