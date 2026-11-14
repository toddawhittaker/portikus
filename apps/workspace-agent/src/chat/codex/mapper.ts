import type { ChatToolOutputPart } from "@portikus/contracts";
import type { z } from "zod";
import type { ChatEventBody } from "../agent.js";
import { imagePart, shortenedInput } from "../claude-adapter.js";
import {
	CollabToolCallItem,
	CommandItem,
	DynamicToolCallItem,
	FileChangeItem,
	ImageViewItem,
	ItemBase,
	McpToolCallItem,
	type PlanStep,
	parsed,
	ReviewItem,
	SubAgentActivityItem,
	TextItem,
	WebSearchItem,
} from "./protocol.js";
import { shortTitle } from "./title.js";

/**
 * Codex items to chat events, under Codex's own tool names and the input
 * shapes the web draws (SPEC.md §10.8). An item this does not know becomes
 * a plain row named by its type. Nothing here touches a socket, so it is
 * tested from recorded app-server traffic.
 */

type Json = ReturnType<typeof shortenedInput>;

export interface ToolRow {
	id: string;
	name: string;
	title: string;
	input: Json;
}

/** Most tool output characters one row keeps; the rest stays in Codex's own record. */
const MAX_TOOL_OUTPUT_CHARS = 65_536;
const CUT = "\n… (shortened)";
/** Most row ids remembered, so a long chat does not grow without bound. */
const MAX_REMEMBERED_ROWS = 500;

/** Items that are conversation, not tools: they never become rows. */
const NOT_TOOLS = new Set([
	"userMessage",
	"agentMessage",
	"reasoning",
	"plan",
	"enteredReviewMode",
	"exitedReviewMode",
	"hookPrompt",
]);

/** How each subagent activity reads as a collaboration tool; `completed` is no step of its own. */
const ACTIVITY_TOOL: Record<string, string> = {
	started: "spawnAgent",
	interacted: "sendInput",
	interrupted: "interruptAgent",
};

function capped(text: string): string {
	return text.length > MAX_TOOL_OUTPUT_CHARS
		? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}${CUT}`
		: text;
}

/**
 * The command as the student would type it: Codex runs each one as
 * `/bin/bash -lc '<command>'`, and only the inner command means anything.
 */
export function shownCommand(command: string): string {
	const wrapped = /^(?:\S*\/)?(?:bash|sh|zsh) -l?c (.*)$/s.exec(command);
	if (!wrapped) return command;
	const inner = wrapped[1] as string;
	if (/^'(?:[^']|'\\'')*'$/s.test(inner))
		return inner.slice(1, -1).replaceAll("'\\''", "'");
	return inner;
}

/** A whole file as a unified diff hunk: every line added, or every line removed. */
function wholeFileDiff(content: string, sign: "+" | "-"): string {
	const lines = content.endsWith("\n")
		? content.slice(0, -1).split("\n")
		: content.split("\n");
	const count = content === "" ? 0 : lines.length;
	const header = sign === "+" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`;
	return [
		header,
		...(count === 0 ? [] : lines.map((line) => `${sign}${line}`)),
		"",
	].join("\n");
}

function fileChanges(item: FileChangeItem) {
	return item.changes.map((change) => {
		const kind = change.kind.type;
		const diff =
			kind === "add"
				? wholeFileDiff(change.diff, "+")
				: kind === "delete"
					? wholeFileDiff(change.diff, "-")
					: change.diff;
		return {
			path: change.path,
			kind,
			...(change.kind.move_path ? { movePath: change.kind.move_path } : {}),
			diff,
		};
	});
}

function commandActions(item: z.infer<typeof CommandItem>) {
	return (item.commandActions ?? []).map((action) => {
		if (action.type === "read" || action.type === "listFiles") {
			return { type: action.type, path: action.path ?? null };
		}
		if (action.type === "search") {
			return { type: "search", query: action.query ?? null, path: action.path ?? null };
		}
		return { type: "unknown" };
	});
}

/** The row an item draws as, or null when it is conversation rather than a tool. */
export function toolRow(item: unknown): ToolRow | null {
	const base = parsed(ItemBase, item);
	if (!base || NOT_TOOLS.has(base.type)) return null;
	const row = (name: string, text: string, input: unknown): ToolRow => ({
		id: base.id,
		name,
		title: shortTitle(text),
		input: shortenedInput(input),
	});
	switch (base.type) {
		case "commandExecution": {
			const command = parsed(CommandItem, item);
			if (!command) break;
			const shown = shownCommand(command.command);
			return row(base.type, shown, {
				command: shown,
				actions: commandActions(command),
			});
		}
		case "fileChange": {
			const change = parsed(FileChangeItem, item);
			if (!change) break;
			const only = change.changes.length === 1 ? change.changes[0]?.path : undefined;
			return row(base.type, only ?? `${change.changes.length} files`, {
				changes: fileChanges(change),
			});
		}
		case "mcpToolCall": {
			const call = parsed(McpToolCallItem, item);
			if (!call) break;
			return row(base.type, call.tool, {
				server: call.server,
				tool: call.tool,
				arguments: call.arguments ?? null,
			});
		}
		case "dynamicToolCall": {
			const call = parsed(DynamicToolCallItem, item);
			if (!call) break;
			return row(base.type, call.tool, {
				tool: call.tool,
				arguments: call.arguments ?? null,
			});
		}
		case "webSearch": {
			const search = parsed(WebSearchItem, item);
			if (!search) break;
			return row(base.type, search.query, { query: search.query });
		}
		case "imageView": {
			const view = parsed(ImageViewItem, item);
			if (!view) break;
			return row(base.type, view.path, { path: view.path });
		}
		case "collabAgentToolCall": {
			const call = parsed(CollabToolCallItem, item);
			if (!call) break;
			return row("collabAgentToolCall", call.tool, {
				tool: call.tool,
				receivers: call.receiverThreadIds,
				...(call.prompt ? { prompt: call.prompt } : {}),
			});
		}
		case "subAgentActivity": {
			const activity = parsed(SubAgentActivityItem, item);
			const tool = activity ? ACTIVITY_TOOL[activity.kind] : undefined;
			if (!activity) break;
			if (!tool) return null;
			return row("collabAgentToolCall", tool, {
				tool,
				receivers: [activity.agentThreadId],
			});
		}
	}
	return row(base.type, base.type, {});
}

/** One MCP content block as an output part. */
function mcpPart(block: unknown): ChatToolOutputPart | null {
	if (typeof block !== "object" || block === null) return null;
	const { type, text, data, mimeType } = block as Record<string, unknown>;
	if (type === "text" && typeof text === "string")
		return { type: "text", text: capped(text) };
	if (type === "image") {
		return imagePart({ source: { type: "base64", media_type: mimeType, data } });
	}
	return null;
}

/** What an item produced, and whether it failed, once it has finished. */
function toolResult(item: unknown): { parts: ChatToolOutputPart[]; isError: boolean } {
	const base = parsed(ItemBase, item);
	const status = (item as { status?: unknown }).status;
	const failed = typeof status === "string" && status !== "completed";
	switch (base?.type) {
		case "commandExecution": {
			const command = parsed(CommandItem, item);
			if (!command) break;
			const output = command.aggregatedOutput ?? "";
			return {
				parts: output === "" ? [] : [{ type: "text", text: capped(output) }],
				isError: failed || (command.exitCode != null && command.exitCode !== 0),
			};
		}
		case "mcpToolCall": {
			const call = parsed(McpToolCallItem, item);
			if (!call) break;
			const parts = (call.result?.content ?? [])
				.map(mcpPart)
				.filter((part): part is ChatToolOutputPart => part !== null);
			if (call.error) parts.push({ type: "text", text: capped(call.error.message) });
			return { parts, isError: failed || Boolean(call.error) };
		}
		case "dynamicToolCall": {
			const call = parsed(DynamicToolCallItem, item);
			if (!call) break;
			const parts = (call.contentItems ?? [])
				.map((content) => {
					const { type, text } = (content ?? {}) as Record<string, unknown>;
					return type === "inputText" && typeof text === "string"
						? { type: "text" as const, text: capped(text) }
						: null;
				})
				.filter((part) => part !== null);
			return { parts, isError: failed || call.success === false };
		}
	}
	return { parts: [], isError: failed };
}

/** The plan a Plan turn ended with, as the row its card's decision lands on. */
export function planRow(id: string, plan: string): ChatEventBody {
	return {
		type: "tool.started",
		id,
		name: "plan",
		title: "Plan",
		input: shortenedInput({ plan }),
	};
}

/**
 * Maps one thread's items. It remembers which rows it has started, so a
 * finished item never draws twice and one seen only finished still draws,
 * and each row's input, which an approval card shows.
 */
export class CodexItemMapper {
	private readonly rows = new Map<string, ToolRow>();
	/** Rows started and not yet finished, oldest first. */
	private readonly running = new Set<string>();
	private planUpdates = 0;

	/** The row an item drew, for its approval card. */
	row(id: string): ToolRow | undefined {
		return this.rows.get(id);
	}

	/**
	 * The running MCP call an approval is about. Codex's request names no
	 * item, so this is the oldest unfinished call to this server and tool
	 * with these arguments that holds no card yet.
	 */
	mcpRow(
		server: string,
		tool: string,
		args: unknown,
		taken: ReadonlySet<string>,
	): ToolRow | undefined {
		const wanted =
			args === undefined
				? undefined
				: JSON.stringify(shortenedInput({ server, tool, arguments: args }));
		for (const id of this.running) {
			const row = this.rows.get(id);
			const input = row?.input as { server?: unknown; tool?: unknown } | null;
			if (
				row?.name === "mcpToolCall" &&
				input?.server === server &&
				input?.tool === tool &&
				!taken.has(row.id) &&
				(wanted === undefined || JSON.stringify(row.input) === wanted)
			) {
				return row;
			}
		}
		return undefined;
	}

	started(item: unknown): ChatEventBody[] {
		const row = toolRow(item);
		if (!row || this.rows.has(row.id)) return [];
		this.remember(row);
		this.running.add(row.id);
		return [{ type: "tool.started", ...row }];
	}

	completed(item: unknown, options: { omitImages?: boolean } = {}): ChatEventBody[] {
		const base = parsed(ItemBase, item);
		if (!base) return [];
		const message = this.message(base.type, base.id, item);
		if (message) return [message];
		const row = toolRow(item);
		if (!row) return [];
		const events = this.rows.has(row.id)
			? []
			: [{ type: "tool.started" as const, ...row }];
		this.remember(row);
		this.running.delete(row.id);
		const { parts, isError } = toolResult(item);
		const output: ChatEventBody[] = parts.map((part) => ({
			type: "tool.output",
			id: row.id,
			part:
				options.omitImages && part.type === "image"
					? { type: "imageOmitted", mediaType: part.mediaType }
					: part,
		}));
		return [...events, ...output, { type: "tool.finished", id: row.id, isError }];
	}

	delta(itemId: string, text: string): ChatEventBody[] {
		return text === "" ? [] : [{ type: "text.delta", messageId: itemId, text }];
	}

	/** A plan-steps update: its own row each time, as Claude's to-do updates are. */
	planSteps(turnId: string, steps: PlanStep[]): ChatEventBody[] {
		this.planUpdates += 1;
		const id = `${turnId}-steps-${this.planUpdates}`;
		const input = shortenedInput({
			steps: steps.map((step) => ({ step: step.step, status: step.status })),
		});
		return [
			{ type: "tool.started", id, name: "planSteps", title: "Plan", input },
			{ type: "tool.finished", id, isError: false },
		];
	}

	/** An assistant message, a finished plan, or a finished review: all shown as Codex's words. */
	private message(type: string, id: string, item: unknown): ChatEventBody | null {
		let markdown: string | undefined;
		if (type === "agentMessage" || type === "plan")
			markdown = parsed(TextItem, item)?.text;
		if (type === "exitedReviewMode") markdown = parsed(ReviewItem, item)?.review;
		if (markdown === undefined || markdown === "") return null;
		return { type: "message", id, role: "assistant", markdown };
	}

	private remember(row: ToolRow): void {
		this.rows.delete(row.id);
		this.rows.set(row.id, row);
		if (this.rows.size > MAX_REMEMBERED_ROWS) {
			const oldest = this.rows.keys().next().value;
			if (oldest !== undefined) {
				this.rows.delete(oldest);
				this.running.delete(oldest);
			}
		}
	}
}
