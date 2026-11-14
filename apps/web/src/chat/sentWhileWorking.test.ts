import { describe, expect, test } from "vitest";
import { type ChatState, initialChatState } from "./chatStore.js";
import { isWorking, sentWhileWorking, takeInSentMessage } from "./sentWhileWorking.js";

/** A chat with one running turn that has shown `work` items so far. */
function running(work: number): ChatState {
	return {
		...initialChatState,
		currentTurnId: "turn-1",
		turns: {
			"turn-1": {
				id: "turn-1",
				startedAt: 100,
				finishedAt: null,
				status: "running",
				estimated: false,
			},
		},
		items: Array.from({ length: work }, (_, index) => ({
			kind: "message" as const,
			key: `message:a${index}`,
			id: `a${index}`,
			role: "assistant" as const,
			markdown: "working",
			attachments: [],
			streaming: false,
			turnId: "turn-1",
		})),
	};
}

describe("isWorking", () => {
	test("only a running turn that has shown work", () => {
		expect(isWorking(initialChatState)).toBe(false);
		expect(isWorking(running(0))).toBe(false);
		expect(isWorking(running(1))).toBe(true);
		const done = running(1);
		const turn = done.turns["turn-1"];
		if (!turn) throw new Error("no turn");
		expect(
			isWorking({ ...done, turns: { "turn-1": { ...turn, status: "done" } } }),
		).toBe(false);
	});
});

describe("a message sent while working", () => {
	test("shows at once, marked, outside the turn, and waits to split it", () => {
		const state = sentWhileWorking(
			running(1),
			{ id: "u1", markdown: "also this", attachments: [] },
			7,
		);
		expect(state.lastUserMessageSeq).toBe(7);
		expect(state.pendingSplit).toBe(7);
		expect(state.items.at(-1)).toMatchObject({
			key: "message:u1",
			role: "user",
			turnId: null,
			whileWorking: true,
			markdown: "also this",
		});
		// A second one keeps the first split point.
		expect(
			sentWhileWorking(state, { id: "u2", markdown: "and", attachments: [] }, 9)
				.pendingSplit,
		).toBe(7);
	});

	test("the agent's next step ends the work so far and starts a turn below the message", () => {
		const sent = sentWhileWorking(
			running(1),
			{ id: "u1", markdown: "also", attachments: [] },
			7,
		);
		const split = takeInSentMessage(sent, 500);
		expect(split.pendingSplit).toBeNull();
		expect(split.currentTurnId).toBe("turn-7");
		expect(split.turns["turn-1"]).toMatchObject({ finishedAt: 500, status: "done" });
		expect(split.turns["turn-7"]).toMatchObject({
			startedAt: 500,
			finishedAt: null,
			status: "running",
		});
	});

	test("with nothing waiting, or no turn, nothing changes", () => {
		const state = running(1);
		expect(takeInSentMessage(state, 500)).toBe(state);
		const noTurn = { ...initialChatState, pendingSplit: 3 };
		expect(takeInSentMessage(noTurn, 500)).toBe(noTurn);
	});
});
