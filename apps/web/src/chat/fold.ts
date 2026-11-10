import type { ChatItem, ChatMessageItem, ChatToolItem } from "./chatStore.js";
import { projectPath, toolLine } from "./toolView.js";

/**
 * A finished turn as the conversation shows it: its first and final
 * assistant messages stay visible, and the tool work and narration between
 * them fold into one "Worked for" block. Errors stay visible.
 */
export interface FoldedTurn {
	/** Shown before the folded block. */
	before: ChatMessageItem | null;
	folded: ChatItem[];
	/** Shown after the folded block. */
	after: ChatMessageItem | null;
	errors: ChatItem[];
}

function isAssistant(item: ChatItem): item is ChatMessageItem {
	return item.kind === "message" && item.role === "assistant";
}

export function foldTurn(items: readonly ChatItem[]): FoldedTurn {
	const assistant = items.filter(isAssistant);
	const first = assistant[0] ?? null;
	const final = assistant.at(-1) ?? null;
	const errors = items.filter((item) => item.kind === "error");
	const folded = items.filter(
		(item) => item !== first && item !== final && item.kind !== "error",
	);
	if (first === null || first !== final) {
		return { before: first, folded, after: final, errors };
	}
	// One message: it stays where it was, before or after the work.
	const firstWork = folded[0];
	const leads =
		firstWork === undefined || items.indexOf(first) < items.indexOf(firstWork);
	return leads
		? { before: first, folded, after: null, errors }
		: { before: null, folded, after: first, errors };
}

/** Two or more tool calls in a row, shown under one disclosure (SPEC.md §10.8). */
export interface ToolRun {
	kind: "tools";
	/** From the first call, so the run keeps its place as it grows. */
	key: string;
	tools: ChatToolItem[];
}

/**
 * Items in order, with each run of consecutive tool calls gathered into one
 * ToolRun. A call that `standsAlone` (a question Claude asked) breaks a run,
 * and a run of one stays a plain row.
 */
export function groupTools(
	items: readonly ChatItem[],
	standsAlone: (tool: ChatToolItem) => boolean,
): (ChatItem | ToolRun)[] {
	const shown: (ChatItem | ToolRun)[] = [];
	let run: ChatToolItem[] = [];
	const close = () => {
		const [first] = run;
		if (first === undefined) return;
		shown.push(
			run.length === 1 ? first : { kind: "tools", key: `run:${first.key}`, tools: run },
		);
		run = [];
	};
	for (const item of items) {
		if (item.kind === "tool" && !standsAlone(item)) {
			run.push(item);
			continue;
		}
		close();
		shown.push(item);
	}
	close();
	return shown;
}

/** One file a turn's Edit, MultiEdit or Write calls changed, with its summed counts. */
export interface ChangedFile {
	path: string;
	added: number;
	removed: number;
}

const CHANGING_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * The files a turn changed, in the order first touched (SPEC.md §10.8). Only
 * calls that finished count, since a failed edit changed nothing; a Write
 * counts every line it wrote as added. Deletions are not seen: no tool here
 * deletes a file. The host drops subagents' calls, so these are the main
 * thread's alone.
 */
export function changedFiles(items: readonly ChatItem[], slug?: string): ChangedFile[] {
	const files = new Map<string, ChangedFile>();
	for (const item of items) {
		if (item.kind !== "tool" || item.status !== "done") continue;
		if (!CHANGING_TOOLS.has(item.name)) continue;
		const line = toolLine(item.name, item.input, item.title);
		const named = line.path ?? (line.verb ? line.target : null);
		if (named === null) continue;
		// A project file has one path however Claude named it; others stay as named.
		const path = projectPath(slug, named) ?? named;
		const counts =
			line.detail?.kind === "write"
				? { added: writtenLines(line.detail.content), removed: 0 }
				: { added: line.added, removed: line.removed };
		const file = files.get(path) ?? { path, added: 0, removed: 0 };
		file.added += counts.added;
		file.removed += counts.removed;
		files.set(path, file);
	}
	return [...files.values()];
}

function writtenLines(content: string): number {
	if (content === "") return 0;
	const lines = content.split("\n");
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}
