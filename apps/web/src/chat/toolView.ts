/**
 * How a tool call reads in the conversation and on a permission card: a
 * one-line summary, a plain sentence for the conversation's row ("Read
 * a.ts", "Ran pnpm test"), and for the common tools the part a student
 * checks (the command, the edit as a diff, the file written) instead of raw
 * JSON.
 */
import { ProjectPath } from "@portikus/contracts";
import { projectRoot } from "../projectRoot.js";

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

function literalView(summary: string, detail: ToolDetail | null = null): ToolView {
	return { summary, literal: true, detail };
}

/** A search pattern, and where it looked when the input says. */
function patternView(pattern: string | null, where: string | null): ToolView | null {
	if (!pattern) return null;
	return literalView(where ? `${pattern} in ${where}` : pattern);
}

function commandView(input: Record<string, unknown>): ToolView | null {
	const command = text(input, "command");
	return command ? literalView(firstLine(command), { kind: "command", command }) : null;
}

function editView(
	input: Record<string, unknown>,
	path: string | null,
): ToolView | null {
	if (!path) return null;
	const changes = editChanges(input);
	return literalView(path, changes ? { kind: "edit", path, changes } : null);
}

function writeView(
	input: Record<string, unknown>,
	path: string | null,
): ToolView | null {
	if (!path) return null;
	const content = typeof input.content === "string" ? input.content : null;
	return literalView(path, content === null ? null : { kind: "write", path, content });
}

/** The view of a tool this file knows, or null when its input lacks what that needs. */
function knownView(name: string, input: unknown): ToolView | null {
	if (!isRecord(input)) return null;
	const path = text(input, "file_path") ?? text(input, "notebook_path");
	switch (name) {
		case "Bash":
			return commandView(input);
		case "Read":
		case "NotebookEdit":
			return path ? literalView(path) : null;
		case "Edit":
		case "MultiEdit":
			return editView(input, path);
		case "Write":
			return writeView(input, path);
		case "Grep":
			return patternView(
				text(input, "pattern"),
				text(input, "path") ?? text(input, "glob"),
			);
		case "Glob":
			return patternView(text(input, "pattern"), text(input, "path"));
		case "WebFetch": {
			const url = text(input, "url");
			return url ? literalView(url) : null;
		}
		case "WebSearch": {
			const query = text(input, "query");
			return query ? { summary: query, literal: false, detail: null } : null;
		}
		default:
			return null;
	}
}

/**
 * A finished call is told in the past, a running one as it happens (the row
 * and the Working line alike), and a failed or stopped one names its action.
 */
interface Verb {
	done: string;
	doing: string;
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

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit", "Write"]);

function baseName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

const EDIT_VERB: Verb = { done: "Edited", doing: "Editing", pending: "Edit" };

const VERBS: Record<string, { icon: ToolLine["icon"]; verb: Verb }> = {
	Bash: { icon: "terminal", verb: { done: "Ran", doing: "Running", pending: "Run" } },
	Read: { icon: "file", verb: { done: "Read", doing: "Reading", pending: "Read" } },
	Edit: { icon: "file-code", verb: EDIT_VERB },
	MultiEdit: { icon: "file-code", verb: EDIT_VERB },
	NotebookEdit: { icon: "file-code", verb: EDIT_VERB },
	Write: {
		icon: "file-code",
		verb: { done: "Wrote", doing: "Writing", pending: "Write" },
	},
	Grep: {
		icon: "search",
		verb: { done: "Searched for", doing: "Searching for", pending: "Search for" },
	},
	Glob: { icon: "list", verb: { done: "Listed", doing: "Listing", pending: "List" } },
	WebFetch: {
		icon: "globe",
		verb: { done: "Fetched", doing: "Fetching", pending: "Fetch" },
	},
	WebSearch: {
		icon: "globe",
		verb: {
			done: "Searched the web for",
			doing: "Searching the web for",
			pending: "Search the web for",
		},
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
	if (detail?.kind === "edit") countEditLines(line, detail.changes);
	return line;
}

function countEditLines(line: ToolLine, changes: EditChange[]): void {
	for (const change of changes) {
		for (const diff of diffLines(change.before, change.after)) {
			if (diff.kind === "added") line.added++;
			if (diff.kind === "removed") line.removed++;
		}
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

/**
 * A tool's path as the project names it: Claude Code runs in
 * `/home/student/projects/<slug>`, so a path under it loses that prefix, a
 * relative one is already the project's, and anything else is not in the
 * project (null). `.` and empty segments go and `..` is resolved, so one file
 * has one path; a path that climbs out of the project, or that the file API
 * would refuse (ProjectPath), is null too.
 */
export function projectPath(slug: string | undefined, path: string): string | null {
	let relative = path;
	if (path.startsWith("/")) {
		if (slug === undefined) return null;
		const root = `${projectRoot(slug)}/`;
		if (!path.startsWith(root)) return null;
		relative = path.slice(root.length);
	}
	const kept: string[] = [];
	for (const part of relative.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") kept.push(part);
		else if (kept.pop() === undefined) return null;
	}
	const clean = kept.join("/");
	return ProjectPath.safeParse(clean).success ? clean : null;
}
