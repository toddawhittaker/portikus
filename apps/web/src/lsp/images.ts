/**
 * Escapes "![" in untrusted Markdown so no image form survives (SPEC.md
 * §13.6, §24.3). Code shows its characters as they are, with no stray
 * backslash, but only where this reading of the Markdown cannot differ from
 * the renderer's. Anything unsure is escaped, because a missed image loads
 * from any https host the CSP allows.
 */

const ESCAPED_IMAGE = "!\\[";

function escapeAll(text: string): string {
	return text.replaceAll("![", ESCAPED_IMAGE);
}

export function escapeImages(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const fenced = fencedLines(lines);
	if (fenced === null) return escapeAll(lines.join("\n"));
	const out: string[] = [];
	let paragraph: string[] = [];
	const endParagraph = () => {
		out.push(...escapeParagraph(paragraph));
		paragraph = [];
	};
	lines.forEach((line, index) => {
		if (fenced[index] === "opening") {
			// The text after the fence marks is the info string, not code.
			endParagraph();
			out.push(escapeAll(line));
		} else if (fenced[index] === "code" || line.trim() === "") {
			endParagraph();
			out.push(line);
		} else {
			paragraph.push(line);
		}
	});
	endParagraph();
	return out.join("\n");
}

/**
 * What each line is, for the lines of a fence that starts at the left edge, or null when
 * the text holds anything else that could be a fence, an HTML block or a
 * link definition. Those
 * can change which lines count as code, so the caller escapes everything.
 */
function fencedLines(lines: string[]): Array<"text" | "opening" | "code"> | null {
	const fenced: Array<"text" | "opening" | "code"> = [];
	let open: RegExp | null = null;
	let definitionMayStart = false;
	for (const line of lines) {
		if (open !== null) {
			fenced.push("code");
			if (open.test(line)) open = null;
			continue;
		}
		const start = /^(`{3,}|~{3,})(.*)$/.exec(line);
		if (start?.[1] !== undefined) {
			// A backtick in a backtick fence's first line makes it inline code.
			if (start[1][0] === "`" && start[2]?.includes("`")) return null;
			// The renderer ends a fence at its marks followed by any mix of
			// backticks and tildes, which is more than CommonMark allows.
			open = new RegExp(`^ {0,3}${start[1]}[~\`]* *$`);
			fenced.push("opening");
			continue;
		}
		if (/^ {0,3}</.test(line) || line.includes("```") || line.includes("~~~")) {
			return null;
		}
		if (/^ {0,3}\[/.test(line)) definitionMayStart = true;
		fenced.push("text");
	}
	// A link definition's label or title can run over a fence line.
	if (definitionMayStart && lines.some((line) => line.includes("]:"))) return null;
	return fenced;
}

/**
 * Text that can swallow a backtick before a code span could start: a tag, a
 * link, emphasis, strikethrough or an address. The renderer's emphasis and
 * link rules do not skip every code span, so these count even where
 * CommonMark would not let them swallow it.
 */
const SWALLOWS_BACKTICK = /[<[\]*_~]|:\/\/|www\./i;

/** The lines of one paragraph with "![" escaped outside code spans. */
function escapeParagraph(paragraph: string[]): string[] {
	// A table row splits at its pipes before it looks for code.
	if (paragraph.some((line) => line.includes("|"))) return paragraph.map(escapeAll);
	// Once a tag, link or address has appeared, a later backtick may be inside it.
	let tainted = false;
	return paragraph.map((line, row) => {
		let out = "";
		let text = "";
		const flush = () => {
			out += escapeAll(text);
			if (SWALLOWS_BACKTICK.test(text)) tainted = true;
			text = "";
		};
		let i = 0;
		while (i < line.length) {
			if (line[i] !== "`") {
				text += line[i];
				i += 1;
				continue;
			}
			const size = /^`+/.exec(line.slice(i))?.[0].length ?? 1;
			// An escaped first backtick leaves a shorter run to open a span.
			if (backslashed(line, i)) tainted = true;
			const end =
				tainted || SWALLOWS_BACKTICK.test(text) ? -1 : closingRun(line, i + size, size);
			if (end === -1) {
				// An opener with no closer on its line may pair with one on a later line.
				if (!tainted && continuesLater(paragraph, row, i + size, size)) tainted = true;
				text += "`".repeat(size);
				i += size;
			} else {
				flush();
				out += line.slice(i, end);
				i = end;
			}
		}
		flush();
		return out;
	});
}

/** Whether a backtick run of exactly this size comes after the position. */
function continuesLater(
	paragraph: string[],
	row: number,
	from: number,
	size: number,
): boolean {
	const rest = [(paragraph[row] ?? "").slice(from), ...paragraph.slice(row + 1)];
	return rest.some((line) => closingRun(line, 0, size) !== -1);
}

/** Whether an odd number of backslashes comes right before the index. */
function backslashed(line: string, index: number): boolean {
	let count = 0;
	while (line[index - 1 - count] === "\\") count += 1;
	return count % 2 === 1;
}

/** The end of the next backtick run of exactly this size, or -1. */
function closingRun(line: string, from: number, size: number): number {
	for (const run of line.slice(from).matchAll(/`+/g)) {
		if (run[0].length === size) return from + run.index + size;
	}
	return -1;
}
