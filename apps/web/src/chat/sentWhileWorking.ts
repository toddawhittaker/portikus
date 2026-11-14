/**
 * A message the student sends while the agent works (SPEC.md §10.8): how
 * the chat state shows it at once, and how the turn divides when the agent
 * takes it in.
 */
import type { ChatMessageItem, ChatState, ChatTurn } from "./chatStore.js";

/** A turn is running and has already shown some work. */
export function isWorking(state: ChatState): boolean {
	const turnId = state.currentTurnId;
	if (turnId === null || state.turns[turnId]?.status !== "running") return false;
	return state.items.some((item) => item.turnId === turnId);
}

/**
 * A message the student sent while Claude worked (SPEC.md §10.8). It shows at
 * once, but the turn goes on until Claude takes it in at its next step, so a
 * tool still running stays on the Working line.
 */
export function sentWhileWorking(
	state: ChatState,
	message: Pick<ChatMessageItem, "id" | "markdown" | "attachments">,
	seq: number,
): ChatState {
	return {
		...state,
		lastUserMessageSeq: seq,
		pendingSplit: state.pendingSplit ?? seq,
		items: [
			...state.items,
			{
				kind: "message",
				key: `message:${message.id}`,
				role: "user",
				streaming: false,
				turnId: null,
				whileWorking: true,
				...message,
			},
		],
	};
}

/**
 * Claude's next step after a sent-while-working message: the work so far is
 * done, and what follows is a new turn below the message, as a reload replays
 * it from the transcript. If the turn ends first, `turn.finished` drops the
 * split, so its end state lands on the work it describes.
 */
export function takeInSentMessage(state: ChatState, now: number): ChatState {
	const before = state.currentTurnId;
	if (state.pendingSplit === null || before === null) return state;
	const turn = state.turns[before] as ChatTurn;
	const next = `turn-${state.pendingSplit}`;
	return {
		...state,
		pendingSplit: null,
		currentTurnId: next,
		turns: {
			...state.turns,
			[before]: { ...turn, finishedAt: now, status: "done" },
			[next]: {
				id: next,
				startedAt: now,
				finishedAt: null,
				status: "running",
				estimated: false,
			},
		},
	};
}
