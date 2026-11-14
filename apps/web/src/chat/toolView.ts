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

export type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** What a file change did to its file; a rename is an update that names a new path. */
type FileChangeKind = "add" | "delete" | "update" | "move";

/** One file of a file-change call, its unified diff read into lines. */
export interface FileChangeView {
	path: string;
	kind: FileChangeKind;
	/** The new path of a moved file. */
	movePath: string | null;
	lines: DiffLine[];
	added: number;
	removed: number;
}

export type ToolDetail =
	| { kind: "command"; command: string }
	| { kind: "edit"; path: string; changes: EditChange[] }
	| { kind: "write"; path: string; content: string }
	| { kind: "files"; files: FileChangeView[] }
	/** What a tool was called with, when that is the part worth reading. */
	| { kind: "arguments"; value: unknown }
	| { kind: "text"; text: string };

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

/** One MCP tool call, from Claude's `mcp__server__tool` name or Codex's `mcpToolCall` item. */
export interface McpCall {
	server: string;
	tool: string;
	arguments: unknown;
}

const CLAUDE_MCP_PREFIX = "mcp__";

export function mcpCall(name: string, input: unknown): McpCall | null {
	if (name === "mcpToolCall") {
		if (!isRecord(input)) return null;
		const server = text(input, "server");
		const tool = text(input, "tool");
		return server && tool ? { server, tool, arguments: input.arguments } : null;
	}
	if (!name.startsWith(CLAUDE_MCP_PREFIX)) return null;
	const rest = name.slice(CLAUDE_MCP_PREFIX.length);
	const at = rest.indexOf("__");
	if (at < 1 || rest.length === at + 2) return null;
	return { server: rest.slice(0, at), tool: rest.slice(at + 2), arguments: input };
}

function argumentsDetail(value: unknown): ToolDetail | null {
	if (value === undefined || value === null) return null;
	if (isRecord(value) && Object.keys(value).length === 0) return null;
	return { kind: "arguments", value };
}

function mcpView(call: McpCall): ToolView {
	return {
		summary: `${call.tool} \u00b7 ${call.server}`,
		literal: false,
		detail: argumentsDetail(call.arguments),
	};
}

/**
 * A Codex file change's diff as lines. A unified diff shows its hunk
 * headers; a change that has none (a new file's content, or a deleted one's)
 * is all added or all removed.
 */
function changeLines(kind: FileChangeKind, diff: string): DiffLine[] {
	const rows = diff.split("\n");
	if (rows.at(-1) === "") rows.pop();
	if (!rows.some((row) => row.startsWith("@@"))) {
		const mark = kind === "delete" ? "removed" : kind === "update" ? "same" : "added";
		return rows.map((row) => ({ kind: mark, text: row }));
	}
	const lines: DiffLine[] = [];
	let inHunk = false;
	for (const row of rows) {
		if (row.startsWith("@@")) {
			inHunk = true;
			lines.push({ kind: "same", text: row });
		} else if (!inHunk || row.startsWith("\\")) {
			// File headers before the first hunk, and "\ No newline at end of file".
		} else if (row.startsWith("+")) {
			lines.push({ kind: "added", text: row.slice(1) });
		} else if (row.startsWith("-")) {
			lines.push({ kind: "removed", text: row.slice(1) });
		} else {
			lines.push({ kind: "same", text: row.slice(1) });
		}
	}
	return lines;
}

function fileChangeKind(
	value: unknown,
	movePath: string | null,
): FileChangeKind | null {
	const kind = isRecord(value) ? value.type : value;
	if (kind === "add" || kind === "delete") return kind;
	if (kind !== "update") return null;
	return movePath !== null ? "move" : "update";
}

/** The files of a fileChange input; a change this cannot read is left out. */
function fileChanges(input: Record<string, unknown>): FileChangeView[] {
	if (!Array.isArray(input.changes)) return [];
	return input.changes.flatMap((change): FileChangeView[] => {
		if (!isRecord(change)) return [];
		const path = text(change, "path");
		const movePath =
			text(change, "movePath") ??
			(isRecord(change.kind) ? text(change.kind, "move_path") : null);
		const kind = fileChangeKind(change.kind, movePath);
		if (!path || kind === null) return [];
		const lines = changeLines(kind, typeof change.diff === "string" ? change.diff : "");
		return [
			{
				path,
				kind,
				movePath,
				lines,
				added: lines.filter((line) => line.kind === "added").length,
				removed: lines.filter((line) => line.kind === "removed").length,
			},
		];
	});
}

function fileChangeView(input: Record<string, unknown>): ToolView | null {
	const files = fileChanges(input);
	const [first] = files;
	if (!first) return null;
	return {
		summary:
			files.length === 1 ? (first.movePath ?? first.path) : `${files.length} files`,
		literal: files.length === 1,
		detail: { kind: "files", files },
	};
}

function planStepsView(input: Record<string, unknown>): ToolView | null {
	if (!Array.isArray(input.steps)) return null;
	const steps = input.steps.flatMap((step) =>
		isRecord(step) && typeof step.step === "string"
			? [{ step: step.step, done: step.status === "completed" }]
			: [],
	);
	if (steps.length === 0) return null;
	const done = steps.filter((step) => step.done).length;
	return {
		summary: `${done} of ${steps.length} steps done`,
		literal: false,
		detail: {
			kind: "text",
			text: steps.map((step) => `${step.done ? "[x]" : "[ ]"} ${step.step}`).join("\n"),
		},
	};
}

/** The plan a plan card asked the student to approve, kept on its row once decided. */
function planCardView(input: Record<string, unknown>): ToolView | null {
	const plan = text(input, "plan");
	if (plan === null) return null;
	return { summary: "", literal: false, detail: { kind: "text", text: plan } };
}

/** What a subagent tool acts on: "a subagent", "2 subagents", or all of them. */
function collabView(input: Record<string, unknown>): ToolView | null {
	const tool = text(input, "tool");
	if (tool === null || !(tool in COLLAB_VERBS)) return null;
	const receivers = collabReceivers(input);
	const summary =
		tool === "listAgents"
			? "subagents"
			: plural(receivers.length, "a subagent", "subagents");
	return { summary, literal: false, detail: null };
}

/** The child thread ids a subagent tool call names. */
export function collabReceivers(input: unknown): string[] {
	if (!isRecord(input) || !Array.isArray(input.receivers)) return [];
	return input.receivers.filter(
		(receiver): receiver is string => typeof receiver === "string" && receiver !== "",
	);
}

/** Codex's subagent tools, told as Claude's Agent rows are. */
const COLLAB_VERBS: Record<string, Verb> = {
	spawnAgent: { done: "Started", doing: "Starting", pending: "Start" },
	sendInput: {
		done: "Sent input to",
		doing: "Sending input to",
		pending: "Send input to",
	},
	sendMessage: {
		done: "Sent a message to",
		doing: "Sending a message to",
		pending: "Send a message to",
	},
	followupTask: {
		done: "Sent a follow-up to",
		doing: "Sending a follow-up to",
		pending: "Send a follow-up to",
	},
	resumeAgent: { done: "Resumed", doing: "Resuming", pending: "Resume" },
	wait: { done: "Waited for", doing: "Waiting for", pending: "Wait for" },
	closeAgent: { done: "Closed", doing: "Closing", pending: "Close" },
	interruptAgent: { done: "Interrupted", doing: "Interrupting", pending: "Interrupt" },
	listAgents: { done: "Listed", doing: "Listing", pending: "List" },
};

/** The path a file tool names: Claude's `file_path`, or Codex's `path` for an image. */
function filePath(name: string, input: Record<string, unknown>): string | null {
	return (
		text(input, "file_path") ??
		text(input, "notebook_path") ??
		(name === "imageView" ? text(input, "path") : null)
	);
}

function plural(count: number, one: string, many: string): string {
	return count <= 1 ? one : `${count} ${many}`;
}

/** The view of a tool this file knows, or null when its input lacks what that needs. */
function knownView(name: string, input: unknown): ToolView | null {
	if (!isRecord(input)) return null;
	const path = filePath(name, input);
	const mcp = mcpCall(name, input);
	if (mcp) return mcpView(mcp);
	switch (name) {
		case "Bash":
		case "commandExecution":
			return commandView(input);
		case "fileChange":
			return fileChangeView(input);
		case "imageView":
			return path ? literalView(path) : null;
		case "dynamicToolCall": {
			const tool = text(input, "tool");
			return tool
				? { summary: tool, literal: false, detail: argumentsDetail(input.arguments) }
				: null;
		}
		case "Skill": {
			const skill = text(input, "skill");
			return skill ? { summary: skill, literal: false, detail: null } : null;
		}
		case "plan":
			return planCardView(input);
		case "planSteps":
			return planStepsView(input);
		case "collabAgentToolCall":
			return collabView(input);
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
		case "WebSearch":
		case "webSearch": {
			const query = text(input, "query");
			return query ? { summary: query, literal: false, detail: null } : null;
		}
		default:
			return null;
	}
}

/** Codex's item types as a student reads them, for the list of tools a group of calls used. */
const TOOL_LABEL: Record<string, string> = {
	commandExecution: "Bash",
	fileChange: "File change",
	webSearch: "Web search",
	imageView: "Image",
	dynamicToolCall: "Tool",
	collabAgentToolCall: "Subagent",
	plan: "Plan",
	planSteps: "Plan steps",
};

/** A tool's name for a list of the tools a run of calls used. */
export function toolLabel(name: string, input: unknown): string {
	const mcp = mcpCall(name, input);
	if (mcp) return mcp.tool;
	return TOOL_LABEL[name] ?? name;
}

/**
 * A call whose permission card asked for a plan to be approved, so its
 * decision reads "Plan approved": Claude's ExitPlanMode, or Codex's `plan`
 * row, which carries the card's id. A card says so with its `plan`, which a
 * finished call no longer holds, so the call's own name stands in for it.
 * Codex's `planSteps` row is a progress list and asks nothing.
 */
export function isPlanCall(name: string): boolean {
	return name === "ExitPlanMode" || name === "plan";
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
	icon:
		| "terminal"
		| "file"
		| "file-code"
		| "file-image"
		| "search"
		| "list"
		| "globe"
		| "box"
		| "layers"
		| "agent"
		| "clipboard-list";
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

const FILE_TOOLS = new Set([
	"Read",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"Write",
	"imageView",
]);

function baseName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

const EDIT_VERB: Verb = { done: "Edited", doing: "Editing", pending: "Edit" };
const RUN_VERB: Verb = { done: "Ran", doing: "Running", pending: "Run" };
const WEB_SEARCH_VERB: Verb = {
	done: "Searched the web for",
	doing: "Searching the web for",
	pending: "Search the web for",
};
const USE_VERB: Verb = { done: "Used", doing: "Using", pending: "Use" };

const VERBS: Record<string, { icon: ToolLine["icon"]; verb: Verb }> = {
	Bash: { icon: "terminal", verb: RUN_VERB },
	commandExecution: { icon: "terminal", verb: RUN_VERB },
	Read: { icon: "file", verb: { done: "Read", doing: "Reading", pending: "Read" } },
	imageView: {
		icon: "file-image",
		verb: { done: "Viewed", doing: "Viewing", pending: "View" },
	},
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
	WebSearch: { icon: "globe", verb: WEB_SEARCH_VERB },
	webSearch: { icon: "globe", verb: WEB_SEARCH_VERB },
	dynamicToolCall: { icon: "box", verb: USE_VERB },
	Skill: {
		icon: "box",
		verb: { done: "Used skill", doing: "Using skill", pending: "Use skill" },
	},
	plan: {
		icon: "clipboard-list",
		verb: {
			done: "Proposed a plan",
			doing: "Proposing a plan",
			pending: "Propose a plan",
		},
	},
	planSteps: {
		icon: "clipboard-list",
		verb: {
			done: "Updated the plan",
			doing: "Updating the plan",
			pending: "Update the plan",
		},
	},
};

const FILE_CHANGE_VERBS: Record<FileChangeKind, Verb> = {
	add: { done: "Created", doing: "Creating", pending: "Create" },
	delete: { done: "Deleted", doing: "Deleting", pending: "Delete" },
	update: EDIT_VERB,
	move: { done: "Moved", doing: "Moving", pending: "Move" },
};
const CHANGE_VERB: Verb = { done: "Changed", doing: "Changing", pending: "Change" };

/** Codex's own reading of a command: a file read, a listing, or a search. */
function commandActionLine(action: unknown): Partial<ToolLine> | null {
	if (!isRecord(action)) return null;
	const path = text(action, "path");
	switch (action.type) {
		case "read":
			if (!path) return null;
			return {
				icon: "file",
				verb: { done: "Read", doing: "Reading", pending: "Read" },
				target: baseName(path),
				literal: true,
				path: baseName(path) === path ? null : path,
			};
		case "listFiles":
			return {
				icon: "list",
				verb: path
					? {
							done: "Listed files in",
							doing: "Listing files in",
							pending: "List files in",
						}
					: { done: "Listed files", doing: "Listing files", pending: "List files" },
				target: path ?? "",
				literal: true,
			};
		case "search": {
			const query = text(action, "query");
			if (!query) return null;
			return {
				icon: "search",
				verb: { done: "Searched for", doing: "Searching for", pending: "Search for" },
				target: path ? `${query} in ${path}` : query,
				literal: true,
			};
		}
		default:
			return null;
	}
}

/** A command Codex read as one known action says so; any other keeps the command. */
function commandExecutionLine(
	input: Record<string, unknown>,
	view: ToolView | null,
): Partial<ToolLine> | null {
	const [only, ...more] = Array.isArray(input.actions) ? input.actions : [];
	const action = more.length === 0 ? commandActionLine(only) : null;
	if (action === null) return null;
	// The row names the action, not the command, so the opened row shows the command.
	return { ...action, detail: view?.detail ?? null };
}

/** The row for a Codex subagent tool; null for a tool this does not know. */
function collabLine(
	input: Record<string, unknown>,
	view: ToolView,
): Partial<ToolLine> | null {
	const tool = text(input, "tool");
	const verb = tool === null ? undefined : COLLAB_VERBS[tool];
	return verb ? { icon: "agent", verb, target: view.summary } : null;
}

function fileChangeLine(files: FileChangeView[]): Partial<ToolLine> {
	const kinds = new Set(files.map((file) => file.kind));
	const [kind] = kinds;
	return {
		icon: "file-code",
		verb: kinds.size === 1 && kind ? FILE_CHANGE_VERBS[kind] : CHANGE_VERB,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
		// Each file's path heads its own diff in the opened row.
		path: null,
	};
}

export function toolLine(name: string, input: unknown, title: string): ToolLine {
	const view = knownView(name, input);
	const known = VERBS[name];
	const mcp = mcpCall(name, input);
	const line: ToolLine = {
		icon: mcp ? "layers" : (known?.icon ?? "box"),
		verb: null,
		target: view?.summary ?? title,
		literal: view?.literal ?? false,
		path: null,
		added: 0,
		removed: 0,
		detail: view?.detail ?? null,
	};
	if (!view || !isRecord(input)) return line;
	if (mcp) {
		line.verb = USE_VERB;
		return line;
	}
	if (name === "fileChange" && view.detail?.kind === "files") {
		return { ...line, ...fileChangeLine(view.detail.files) };
	}
	if (name === "collabAgentToolCall") {
		return { ...line, ...collabLine(input, view) };
	}
	if (!known) return line;
	line.verb = known.verb;
	const detail = view.detail;
	if (detail?.kind === "command" && !detail.command.includes("\n")) line.detail = null;
	if (name === "commandExecution") {
		Object.assign(line, commandExecutionLine(input, view));
	}
	const path = FILE_TOOLS.has(name) ? filePath(name, input) : null;
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
