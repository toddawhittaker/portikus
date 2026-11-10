import type { ChatItem, ChatMessageItem, ChatToolItem } from "./chatStore.js";

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
