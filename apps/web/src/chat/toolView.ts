/**
 * How a tool call reads in the conversation and on a permission card: a
 * one-line summary, a plain sentence for the conversation's row ("Read
 * a.ts", "Ran pnpm test"), and for the common tools the part a student
 * checks (the command, the edit as a diff, the file written) instead of raw
 * JSON.
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
	return knownView(name, input) ?? { summary: title, literal: false, detail: null };
}

/** The view of a tool this file knows, or null when its input lacks what that needs. */
function knownView(name: string, input: unknown): ToolView | null {
	if (!isRecord(input)) return null;
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
				: null;
		}
		case "Read":
			return path ? { summary: path, literal: true, detail: null } : null;
		case "Edit":
		case "MultiEdit": {
			const changes = editChanges(input);
			if (!path) return null;
			return {
				summary: path,
				literal: true,
				detail: changes ? { kind: "edit", path, changes } : null,
			};
		}
		case "Write": {
			const content = typeof input.content === "string" ? input.content : null;
			if (!path) return null;
			return {
				summary: path,
				literal: true,
				detail: content === null ? null : { kind: "write", path, content },
			};
		}
		case "Grep": {
			const pattern = text(input, "pattern");
			if (!pattern) return null;
			const where = text(input, "path") ?? text(input, "glob");
			return {
				summary: where ? `${pattern} in ${where}` : pattern,
				literal: true,
				detail: null,
			};
		}
		case "Glob": {
			const pattern = text(input, "pattern");
			if (!pattern) return null;
			const where = text(input, "path");
			return {
				summary: where ? `${pattern} in ${where}` : pattern,
				literal: true,
				detail: null,
			};
		}
		case "WebFetch": {
			const url = text(input, "url");
			return url ? { summary: url, literal: true, detail: null } : null;
		}
		case "WebSearch": {
			const query = text(input, "query");
			return query ? { summary: query, literal: false, detail: null } : null;
		}
		default:
			return null;
	}
}

/** A finished call is told in the past; one running, failed or stopped names its action. */
interface Verb {
	done: string;
	pending: string;
}

/** The light one-line row a tool call becomes in the conversation. */
export interface ToolLine {
	icon: "terminal" | "file" | "file-code" | "search" | "list" | "globe" | "box";
	/** Null for an unknown tool, or input without what the verb needs; the row then names the tool. */
	verb: Verb | null;
	/** What it acted on: a file's name, the command's first line, a pattern. */
	target: string;
	literal: boolean;
	/** The whole path, when the target is only its last part. */
	path: string | null;
	/** Lines an edit added and removed. */
	added: number;
	removed: number;
	/** What the opened row shows; a command the row already shows whole is left out. */
	detail: ToolDetail | null;
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write"]);

function baseName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

const VERBS: Record<string, { icon: ToolLine["icon"]; verb: Verb }> = {
	Bash: { icon: "terminal", verb: { done: "Ran", pending: "Run" } },
	Read: { icon: "file", verb: { done: "Read", pending: "Read" } },
	Edit: { icon: "file-code", verb: { done: "Edited", pending: "Edit" } },
	MultiEdit: { icon: "file-code", verb: { done: "Edited", pending: "Edit" } },
	Write: { icon: "file-code", verb: { done: "Wrote", pending: "Write" } },
	Grep: { icon: "search", verb: { done: "Searched for", pending: "Search for" } },
	Glob: { icon: "list", verb: { done: "Listed", pending: "List" } },
	WebFetch: { icon: "globe", verb: { done: "Fetched", pending: "Fetch" } },
	WebSearch: {
		icon: "globe",
		verb: { done: "Searched the web for", pending: "Search the web for" },
	},
};

export function toolLine(name: string, input: unknown, title: string): ToolLine {
	const view = knownView(name, input);
	const known = VERBS[name];
	const line: ToolLine = {
		icon: known?.icon ?? "box",
		verb: null,
		target: view?.summary ?? title,
		literal: view?.literal ?? false,
		path: null,
		added: 0,
		removed: 0,
		detail: view?.detail ?? null,
	};
	if (!known || !view || !isRecord(input)) return line;
	line.verb = known.verb;
	const detail = view.detail;
	if (detail?.kind === "command" && !detail.command.includes("\n")) line.detail = null;
	const path = FILE_TOOLS.has(name)
		? (text(input, "file_path") ?? text(input, "notebook_path"))
		: null;
	if (path) {
		line.target = baseName(path);
		line.path = line.target === path ? null : path;
	}
	if (detail?.kind === "edit") {
		for (const change of detail.changes) {
			for (const diff of diffLines(change.before, change.after)) {
				if (diff.kind === "added") line.added++;
				if (diff.kind === "removed") line.removed++;
			}
		}
	}
	return line;
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
const OUTPUT_PREVIEW_LINES = 12;

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
