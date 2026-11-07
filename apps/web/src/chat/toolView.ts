/**
 * How a tool call reads in the conversation and on a permission card: a
 * one-line summary, and for the common tools the part a student checks (the
 * command, the edit as a diff, the file written) instead of raw JSON.
 */

export interface EditChange {
	before: string;
	after: string;
}

export type ToolDetail =
	| { kind: "command"; command: string }
	| { kind: "edit"; path: string; changes: EditChange[] }
	| { kind: "write"; path: string; content: string };

export interface ToolView {
	/** One line for the collapsed row; empty when nothing better than the title exists. */
	summary: string;
	/** The summary is a command, path or pattern, set in monospace. */
	literal: boolean;
	detail: ToolDetail | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(input: Record<string, unknown>, key: string): string | null {
	const value = input[key];
	return typeof value === "string" && value !== "" ? value : null;
}

function firstLine(value: string): string {
	const line = value.split("\n", 1)[0] ?? "";
	return line.length < value.length ? `${line} …` : line;
}

function editChanges(input: Record<string, unknown>): EditChange[] | null {
	const single = [input.old_string, input.new_string];
	if (typeof single[0] === "string" && typeof single[1] === "string") {
		return [{ before: single[0], after: single[1] }];
	}
	if (!Array.isArray(input.edits)) return null;
	const changes = input.edits.flatMap((edit) =>
		isRecord(edit) &&
		typeof edit.old_string === "string" &&
		typeof edit.new_string === "string"
			? [{ before: edit.old_string, after: edit.new_string }]
			: [],
	);
	return changes.length > 0 ? changes : null;
}

export function toolView(name: string, input: unknown, title: string): ToolView {
	const fallback: ToolView = { summary: title, literal: false, detail: null };
	if (!isRecord(input)) return fallback;
	const path = text(input, "file_path") ?? text(input, "notebook_path");
	switch (name) {
		case "Bash": {
			const command = text(input, "command");
			return command
				? {
						summary: firstLine(command),
						literal: true,
						detail: { kind: "command", command },
					}
				: fallback;
		}
		case "Read":
			return path ? { summary: path, literal: true, detail: null } : fallback;
		case "Edit":
		case "MultiEdit": {
			const changes = editChanges(input);
			if (!path) return fallback;
			return {
				summary: path,
				literal: true,
				detail: changes ? { kind: "edit", path, changes } : null,
			};
		}
		case "Write": {
			const content = typeof input.content === "string" ? input.content : null;
			if (!path) return fallback;
			return {
				summary: path,
				literal: true,
				detail: content === null ? null : { kind: "write", path, content },
			};
		}
		case "Grep": {
			const pattern = text(input, "pattern");
			if (!pattern) return fallback;
			const where = text(input, "path") ?? text(input, "glob");
			return {
				summary: where ? `${pattern} in ${where}` : pattern,
				literal: true,
				detail: null,
			};
		}
		case "Glob": {
			const pattern = text(input, "pattern");
			if (!pattern) return fallback;
			const where = text(input, "path");
			return {
				summary: where ? `${pattern} in ${where}` : pattern,
				literal: true,
				detail: null,
			};
		}
		case "WebFetch": {
			const url = text(input, "url");
			return url ? { summary: url, literal: true, detail: null } : fallback;
		}
		case "WebSearch": {
			const query = text(input, "query");
			return query ? { summary: query, literal: false, detail: null } : fallback;
		}
		default:
			return fallback;
	}
}

export type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** Lines shared at the start and end stay as context; the middle is removed, then added. */
export function diffLines(before: string, after: string): DiffLine[] {
	const old = before.split("\n");
	const next = after.split("\n");
	let head = 0;
	while (head < old.length && head < next.length && old[head] === next[head]) head++;
	let tail = 0;
	while (
		tail < old.length - head &&
		tail < next.length - head &&
		old[old.length - 1 - tail] === next[next.length - 1 - tail]
	) {
		tail++;
	}
	const same = (text: string): DiffLine => ({ kind: "same", text });
	return [
		...old.slice(0, head).map(same),
		...old
			.slice(head, old.length - tail)
			.map((text): DiffLine => ({ kind: "removed", text })),
		...next
			.slice(head, next.length - tail)
			.map((text): DiffLine => ({ kind: "added", text })),
		...old.slice(old.length - tail).map(same),
	];
}

/** Long output is cut to this many lines until the student asks for the rest. */
export const OUTPUT_PREVIEW_LINES = 12;

/** The first `lines` lines of `value`, and how many were left out. */
export function previewText(
	value: string,
	lines = OUTPUT_PREVIEW_LINES,
): { shown: string; hidden: number } {
	const all = value.split("\n");
	// Trailing newlines are not lines anyone reads.
	while (all.length > 1 && all.at(-1) === "") all.pop();
	if (all.length <= lines) return { shown: all.join("\n"), hidden: 0 };
	return { shown: all.slice(0, lines).join("\n"), hidden: all.length - lines };
}
