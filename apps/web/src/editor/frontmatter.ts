/**
 * Splitting a Markdown file's frontmatter from its body (SPEC.md §13.4).
 * Frontmatter is metadata at the very top of the file, fenced by `---` for
 * YAML or `+++` for TOML. The preview shows it as raw text, never as
 * Markdown, so a `title:` line cannot turn into a heading.
 */

export interface SplitMarkdown {
	/** The raw text between the fences, or null when there is none. */
	frontmatter: string | null;
	/** Everything after the closing fence, or the whole text when there is none. */
	body: string;
}

const FENCES = new Set(["---", "+++"]);

export function splitFrontmatter(text: string): SplitMarkdown {
	const lines = text.split("\n");
	// trimEnd also drops the \r of a CRLF file.
	const first = (lines[0] ?? "").trimEnd();
	if (!FENCES.has(first)) return { frontmatter: null, body: text };

	for (let index = 1; index < lines.length; index += 1) {
		if ((lines[index] ?? "").trimEnd() !== first) continue;
		return {
			frontmatter: lines.slice(1, index).map(stripCarriageReturn).join("\n"),
			body: lines.slice(index + 1).join("\n"),
		};
	}

	// An unclosed fence is just text: treat the whole file as the body.
	return { frontmatter: null, body: text };
}

function stripCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
