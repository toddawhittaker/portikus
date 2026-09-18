/**
 * Turning the matches a search returns into what the panel draws
 * (SPEC.md §11.5). Kept apart from the component so the slicing rules can be
 * tested on their own.
 */
import type { SearchMatch } from "@portikus/contracts";

/** Every match in one file, in the order the search reported them. */
export interface FileGroup {
	path: string;
	matches: SearchMatch[];
}

/** Group matches by file, keeping the order each file first appeared in. */
export function groupByFile(matches: SearchMatch[]): FileGroup[] {
	const groups: FileGroup[] = [];
	const byPath = new Map<string, FileGroup>();
	for (const match of matches) {
		let group = byPath.get(match.path);
		if (!group) {
			group = { path: match.path, matches: [] };
			byPath.set(match.path, group);
			groups.push(group);
		}
		group.matches.push(match);
	}
	return groups;
}

/** A matching line split around the part the query matched. */
export interface HighlightParts {
	before: string;
	match: string;
	after: string;
}

/**
 * Split one matching line at the reported column. The column is 1-based and
 * counts the whole line, so on a long line it can point past the 300-character
 * slice the agent sent; then there is nothing to highlight.
 */
export function highlightParts(
	text: string,
	column: number,
	length: number,
): HighlightParts {
	const start = Math.max(0, Math.min(column - 1, text.length));
	const end = Math.max(start, Math.min(start + Math.max(0, length), text.length));
	return {
		before: text.slice(0, start),
		match: text.slice(start, end),
		after: text.slice(end),
	};
}
