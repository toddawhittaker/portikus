import {
	type ChatShellItem,
	MAX_CHAT_SHELL_COMMAND_CHARS,
	MAX_CHAT_SHELL_OUTPUT_CHARS,
} from "@portikus/contracts";
import type { ChatEventBody } from "../agent.js";
import { splitAttachmentLines } from "../attachments.js";
import { CodexItemMapper, shownCommand } from "./mapper.js";
import {
	CommandItem,
	ItemBase,
	parsed,
	type Turn,
	UserMessageItem,
} from "./protocol.js";

/**
 * A Codex thread's turns replayed as chat events for an attach (SPEC.md
 * §10.8): per turn `turn.started`, its items, then `turn.finished` unless
 * it is still running. A turn that only ran a `!` command replays as that
 * command. Images older than the last five turns are left out.
 */

/** Turns replayed on attach, as for Claude. */
export const REPLAYED_TURNS = 20;
const IMAGE_TURNS = 5;

export type TurnStatus = "done" | "interrupted" | "error";

export function turnStatus(status: string): TurnStatus {
	if (status === "interrupted") return "interrupted";
	if (status === "failed") return "error";
	return "done";
}

/** A `!` command Codex ran for the student, as the chat's shell item. */
export function shellItem(id: string, item: CommandItem): ChatShellItem {
	const output = item.aggregatedOutput ?? "";
	const running = item.status === "inProgress";
	return {
		kind: "shell",
		id,
		command: shownCommand(item.command).slice(0, MAX_CHAT_SHELL_COMMAND_CHARS),
		output: output.slice(0, MAX_CHAT_SHELL_OUTPUT_CHARS),
		// Codex reports -1 for a command it stopped.
		exitCode:
			running || item.exitCode == null || item.exitCode < 0 ? null : item.exitCode,
		truncated: output.length > MAX_CHAT_SHELL_OUTPUT_CHARS,
		state: running ? "running" : "done",
	};
}

/** The student's own `!` command, which Codex runs outside the model. */
export function userShell(item: unknown): CommandItem | null {
	const command = parsed(CommandItem, item);
	return command?.source === "userShell" ? command : null;
}

function userMessage(id: string, item: unknown): ChatEventBody | null {
	const message = parsed(UserMessageItem, item);
	if (!message) return null;
	const body = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	const { text, attachments } = splitAttachmentLines(body);
	if (text === "" && attachments.length === 0) return null;
	return {
		type: "message",
		id,
		role: "user",
		markdown: text,
		...(attachments.length > 0 ? { attachments } : {}),
	};
}

function seconds(at: number | null | undefined): number {
	return typeof at === "number" && at > 0 ? Math.round(at * 1000) : 0;
}

/** A turn that only ran `!` commands, as those commands; null for any other turn. */
function shellTurn(items: readonly unknown[]): ChatEventBody[] | null {
	const events: ChatEventBody[] = [];
	for (const item of items) {
		const shell = userShell(item);
		const id = parsed(ItemBase, item)?.id;
		if (!shell || !id) return null;
		const { kind: _, ...fields } = shellItem(id, shell);
		events.push({ type: "shell", ...fields });
	}
	return events.length > 0 ? events : null;
}

/** One item of a replayed turn. */
function itemEvents(
	mapper: CodexItemMapper,
	item: unknown,
	running: boolean,
	omitImages: boolean,
): ChatEventBody[] {
	const base = parsed(ItemBase, item);
	if (!base) return [];
	if (base.type === "userMessage") {
		const message = userMessage(base.id, item);
		return message ? [message] : [];
	}
	// In a running turn, a reply still being written arrives as the core's streamed text.
	const { status, completedAtMs } = item as {
		status?: unknown;
		completedAtMs?: unknown;
	};
	const unfinished = status === "inProgress" || (running && completedAtMs === null);
	return unfinished ? mapper.started(item) : mapper.completed(item, { omitImages });
}

/** Replay turns, oldest first. */
export function replayTurns(turns: readonly Turn[]): ChatEventBody[] {
	const mapper = new CodexItemMapper();
	const events: ChatEventBody[] = [];
	turns.forEach((turn, index) => {
		const items = turn.items ?? [];
		const shells = shellTurn(items);
		if (shells) {
			events.push(...shells);
			return;
		}
		const omitImages = index < turns.length - IMAGE_TURNS;
		const running = turn.status === "inProgress";
		events.push({ type: "turn.started", at: seconds(turn.startedAt) });
		for (const item of items)
			events.push(...itemEvents(mapper, item, running, omitImages));
		if (!running) {
			events.push({
				type: "turn.finished",
				status: turnStatus(turn.status),
				at: seconds(turn.completedAt),
			});
		}
	});
	return events;
}
