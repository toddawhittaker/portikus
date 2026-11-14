/**
 * Starting fresh with a handoff note, as the chat store keeps it (SPEC.md
 * §10.8): the note waiting for review, and the divider where the chat
 * started fresh from one.
 */
import type { ChatServerEvent, CodingAgent } from "@portikus/contracts";
import type { ChatState } from "./chatStore.js";

/** Where the chat changed agents: a divider in the conversation (SPEC.md §10.8). */
export interface ChatHandoffItem {
	kind: "handoff";
	key: string;
	from: CodingAgent;
	to: CodingAgent;
	/** The oldest turns that did not fit the new agent's context window. */
	droppedTurns: number;
	/** The new agent could not take the conversation in, so it started without it. */
	failed: boolean;
	turnId: null;
}

/** Where the chat started fresh from a handoff note: a divider in the conversation. */
export interface ChatFreshStartItem {
	kind: "freshStart";
	key: string;
	/** The divider's own id, which a resend names. */
	id: string;
	/** The note, relative to the project. */
	path: string;
	/** The new conversation's first message failed; it can be sent again. */
	failed: boolean;
	turnId: null;
}

/**
 * A handoff note the host wrote on its own while the student was away: a
 * notice in the conversation. Only the newest one offers its buttons.
 */
export interface ChatAutoHandoffItem {
	kind: "autoHandoff";
	key: string;
	/** The notice's id, which Start fresh names. */
	id: string;
	path: string;
	markdown: string;
	/** A newer note was written since. */
	superseded: boolean;
	turnId: null;
}

type FreshStartEvent = Extract<
	ChatServerEvent,
	{ type: "handoff.review" | "handoff.fresh" | "handoff.auto" }
>;

/** One handoff event applied: the review replaced, or the divider or notice added or updated in place. */
export function applyFreshStart(state: ChatState, event: FreshStartEvent): ChatState {
	if (event.type === "handoff.review") return { ...state, handoffReview: event.review };
	if (event.type === "handoff.auto") return addNotice(state, event);
	const item: ChatFreshStartItem = {
		kind: "freshStart",
		key: `fresh:${event.id}`,
		id: event.id,
		path: event.path,
		failed: event.failed === true,
		turnId: null,
	};
	const known = state.items.some((one) => one.key === item.key);
	const items = known
		? state.items.map((one) => (one.key === item.key ? item : one))
		: [...state.items, item];
	return { ...state, items };
}

function addNotice(
	state: ChatState,
	event: Extract<ChatServerEvent, { type: "handoff.auto" }>,
): ChatState {
	const key = `auto:${event.id}`;
	if (state.items.some((one) => one.key === key)) return state;
	const item: ChatAutoHandoffItem = {
		kind: "autoHandoff",
		key,
		id: event.id,
		path: event.path,
		markdown: event.markdown,
		superseded: false,
		turnId: null,
	};
	const items = state.items.map((one) =>
		one.kind === "autoHandoff" && !one.superseded ? { ...one, superseded: true } : one,
	);
	return { ...state, items: [...items, item] };
}

/**
 * The automatic note a message sent now could start fresh from: the newest
 * notice, with nothing the student sent after it. Null when there is none.
 */
export function selectSendableNote(state: ChatState): ChatAutoHandoffItem | null {
	for (let at = state.items.length - 1; at >= 0; at--) {
		const item = state.items[at];
		if (item?.kind === "autoHandoff") return item;
		if (item?.kind === "message" && item.role === "user") return null;
		if (item?.kind === "shell") return null;
	}
	return null;
}
