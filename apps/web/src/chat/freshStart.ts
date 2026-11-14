/**
 * Starting fresh with a handoff note, as the chat store keeps it (SPEC.md
 * §10.8): the note waiting for review, and the divider where the chat
 * started fresh from one.
 */
import type { ChatServerEvent } from "@portikus/contracts";
import type { ChatState } from "./chatStore.js";

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

type FreshStartEvent = Extract<
	ChatServerEvent,
	{ type: "handoff.review" | "handoff.fresh" }
>;

/** One handoff event applied: the review replaced, or the divider added or updated in place. */
export function applyFreshStart(state: ChatState, event: FreshStartEvent): ChatState {
	if (event.type === "handoff.review") return { ...state, handoffReview: event.review };
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
