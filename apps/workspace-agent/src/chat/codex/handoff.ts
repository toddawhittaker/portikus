import { CODING_AGENT_LABEL, type CodingAgent } from "@portikus/contracts";
import type { ChatEventBody } from "../agent.js";
import {
	fitTurns,
	type Handoff,
	type HandoffTurn,
	handoffIntro,
	toolNote,
	turnsFor,
} from "../handoff.js";
import type { AppServerClient } from "./app-server.js";
import { replayTurns } from "./history.js";
import { parsed, type Turn, TurnsList } from "./protocol.js";

/** Turns read per page for a whole thread. */
const PAGE_TURNS = 100;

type Turns = readonly { agent: CodingAgent; turn: HandoffTurn }[];

function message(role: "user" | "assistant", text: string): unknown {
	const type = role === "user" ? "input_text" : "output_text";
	return { type: "message", role, content: [{ type, text }] };
}

/**
 * The handoff as raw Responses API items, which `thread/inject_items` adds
 * to the thread's model-visible history (SPEC.md §10.8): an opening note,
 * then each turn's student message and the other agent's reply, its tool
 * calls as a summary line inside that reply, never as Codex's own calls.
 */
function handoffItems(turns: Turns, dropped: number): unknown[] {
	const items = [
		message(
			"user",
			handoffIntro(
				turns.map((each) => each.agent),
				dropped,
			),
		),
	];
	for (const { agent, turn } of turns) {
		if (turn.user !== "") items.push(message("user", turn.user));
		const reply = [
			turn.reply === "" ? "" : `${CODING_AGENT_LABEL[agent]}: ${turn.reply}`,
			toolNote(agent, turn.tools),
		]
			.filter((part) => part !== "")
			.join("\n\n");
		if (reply !== "") items.push(message("assistant", reply));
	}
	return items;
}

/**
 * The handoff a Codex chat takes when it starts after a swap. Codex always
 * starts a fresh thread with the whole conversation; a thread resumed later
 * already holds it.
 */
export class CodexHandoff {
	private items: unknown[] | null = null;
	/** The thread began in this host, so nothing has been put in it yet. */
	fresh = false;

	constructor(
		private readonly target: () => {
			client: AppServerClient | null;
			threadId: string | null;
		},
	) {}

	async adopt(handoff: Handoff, windowTokens: number | null): Promise<number> {
		const { kept, dropped } = fitTurns(
			turnsFor(handoff.log, "codex", false),
			windowTokens,
		);
		const { threadId } = this.target();
		if (threadId && !this.fresh) return dropped;
		this.items = handoffItems(kept, dropped);
		await this.inject();
		return dropped;
	}

	/** Put the handoff into a fresh thread, once. */
	async inject(): Promise<void> {
		const { client, threadId } = this.target();
		const items = this.items;
		if (!items || !client || !threadId || !this.fresh) return;
		await client.request("thread/inject_items", { threadId, items });
		this.items = null;
	}
}

/** Every turn of a thread, oldest first, as chat events. */
export async function codexTranscript(
	client: AppServerClient,
	threadId: string,
): Promise<ChatEventBody[]> {
	const turns: Turn[] = [];
	let cursor: string | null = null;
	do {
		const page: { data: Turn[]; nextCursor?: string | null } | null = parsed(
			TurnsList,
			await client.request("thread/turns/list", {
				threadId,
				limit: PAGE_TURNS,
				sortDirection: "desc",
				itemsView: "full",
				...(cursor ? { cursor } : {}),
			}),
		);
		if (!page) break;
		turns.push(...page.data);
		cursor = page.nextCursor ?? null;
	} while (cursor);
	return replayTurns(turns.reverse());
}
