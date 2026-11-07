import type { ChatClientMessage, ChatServerEvent } from "@portikus/contracts";
import { expect, test, vi } from "vitest";
import {
	type ChatState,
	createChatStore,
	initialChatState,
	receiveChatEvent,
	receiveChatFrame,
} from "./chatStore";

const SESSION = "11111111-1111-4111-8111-111111111111";

type Body<T extends ChatServerEvent["type"]> = Omit<
	Extract<ChatServerEvent, { type: T }>,
	"sessionId" | "seq" | "type"
>;

function frame<T extends ChatServerEvent["type"]>(
	type: T,
	seq: number,
	body: Body<T>,
): string {
	return JSON.stringify({ type, sessionId: SESSION, seq, ...body });
}

function snapshot(seq: number, extra: Partial<Body<"snapshot">> = {}): string {
	return frame("snapshot", seq, {
		messages: [],
		cards: [],
		turnRunning: false,
		truncated: false,
		...extra,
	});
}

function feed(
	frames: string[],
	state: ChatState = initialChatState,
	now = 1000,
): ChatState {
	return frames.reduce((next, data) => receiveChatFrame(next, data, now), state);
}

function texts(state: ChatState): string[] {
	return state.items.map((item) =>
		item.kind === "message" ? item.markdown : item.kind,
	);
}

test("events that arrive before the snapshot wait for it, then apply in seq order", () => {
	const state = feed([
		frame("text.delta", 3, { messageId: "m1", text: " world" }),
		frame("text.delta", 2, { messageId: "m1", text: "Hello" }),
		snapshot(1),
	]);
	expect(state.loaded).toBe(true);
	expect(texts(state)).toEqual(["Hello world"]);
	expect(state.lastSeq).toBe(3);
});

test("an event at or before the last applied seq is dropped", () => {
	const state = feed([
		snapshot(5),
		frame("text.delta", 5, { messageId: "m1", text: "stale" }),
		frame("text.delta", 6, { messageId: "m1", text: "fresh" }),
		frame("text.delta", 6, { messageId: "m1", text: " again" }),
	]);
	expect(texts(state)).toEqual(["fresh"]);
});

test("an early event already covered by the snapshot is not applied twice", () => {
	const state = feed([
		frame("message", 2, { id: "m1", role: "assistant", markdown: "old" }),
		snapshot(4, { messages: [{ id: "m1", role: "assistant", markdown: "old" }] }),
	]);
	expect(texts(state)).toEqual(["old"]);
});

test("invalid frames are dropped and counted", () => {
	const state = feed([
		snapshot(0),
		"not json",
		JSON.stringify({ type: "text.delta", seq: 1 }),
		JSON.stringify({ type: "nonsense", sessionId: SESSION, seq: 2 }),
		frame("tool.output", 3, {
			id: "t1",
			// SVG can carry script, so the contract refuses it.
			part: { type: "image", mediaType: "image/svg+xml", data: "AAAA" } as never,
		}),
	]);
	expect(state.invalidFrames).toBe(4);
	expect(state.lastSeq).toBe(0);
	expect(receiveChatFrame(state, new ArrayBuffer(4), 0).invalidFrames).toBe(5);
});

test("a snapshot replaces the conversation and its cards", () => {
	const state = feed([
		snapshot(0),
		frame("message", 1, { id: "u1", role: "user", markdown: "hi" }),
		snapshot(0, {
			messages: [{ id: "a9", role: "assistant", markdown: "restored" }],
			cards: [
				{
					type: "permission",
					id: "p1",
					toolName: "Bash",
					title: "Run tests",
					input: { command: "pnpm test" },
					options: [{ id: "allow", label: "Allow" }],
				},
			],
			truncated: true,
		}),
	]);
	expect(texts(state)).toEqual(["restored"]);
	expect(state.cards.map((card) => card.id)).toEqual(["p1"]);
	expect(state.truncated).toBe(true);
});

test("a turn streams, runs a tool, and finishes with its times", () => {
	let state = feed([snapshot(0)], initialChatState, 0);
	state = receiveChatFrame(state, frame("turn.started", 1, {}), 1_000);
	state = feed(
		[
			frame("text.delta", 2, { messageId: "a1", text: "Let me look" }),
			frame("tool.started", 3, {
				id: "t1",
				name: "Read",
				title: "src/a.ts",
				input: { path: "a" },
			}),
			frame("tool.output", 4, { id: "t1", part: { type: "text", text: "contents" } }),
			frame("tool.output", 5, {
				id: "t1",
				part: { type: "imageOmitted", mediaType: "image/png" },
			}),
			frame("tool.finished", 6, { id: "t1", isError: true }),
			frame("message", 7, { id: "a1", role: "assistant", markdown: "Let me look." }),
		],
		state,
		2_000,
	);
	const turnId = state.currentTurnId;
	expect(turnId).not.toBeNull();
	const [message, tool] = state.items;
	expect(message).toMatchObject({ markdown: "Let me look.", streaming: false, turnId });
	expect(tool).toMatchObject({ kind: "tool", status: "error", turnId });
	expect(tool?.kind === "tool" && tool.output).toHaveLength(2);

	state = receiveChatFrame(
		state,
		frame("turn.finished", 8, { status: "done" }),
		224_000,
	);
	expect(state.currentTurnId).toBeNull();
	expect(state.turns[turnId ?? ""]).toMatchObject({
		startedAt: 1_000,
		finishedAt: 224_000,
		status: "done",
	});
});

test("a user message is never part of a turn", () => {
	const state = feed([
		snapshot(0, { turnRunning: true }),
		frame("message", 1, { id: "u1", role: "user", markdown: "and also" }),
	]);
	expect(state.currentTurnId).not.toBeNull();
	expect(state.items[0]?.turnId).toBeNull();
});

test("cards are added once and cleared when resolved", () => {
	const question = frame("question.requested", 1, {
		id: "q1",
		questions: [
			{
				question: "Which?",
				header: "Pick",
				multiSelect: false,
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
				],
			},
		],
	});
	let state = feed([snapshot(0), question]);
	state = receiveChatEvent(state, { ...JSON.parse(question), seq: 2 }, 0);
	expect(state.cards).toHaveLength(1);
	state = feed([frame("card.resolved", 3, { id: "q1" })], state);
	expect(state.cards).toEqual([]);
});

test("settings and errors are kept", () => {
	const state = feed([
		snapshot(0),
		frame("settings", 1, {
			agent: "claude",
			model: "opus",
			effort: "high",
			mode: "plan",
		}),
		frame("error", 2, { message: "Claude Code is not signed in" }),
	]);
	expect(state.settings).toEqual({
		agent: "claude",
		model: "opus",
		effort: "high",
		mode: "plan",
	});
	expect(state.items).toEqual([
		{
			kind: "error",
			key: "error:2",
			message: "Claude Code is not signed in",
			turnId: null,
		},
	]);
});

test("actions send valid messages and refuse invalid ones", () => {
	const sent: ChatClientMessage[] = [];
	const store = createChatStore((message) => {
		sent.push(message);
		return true;
	});
	const actions = store.getState();
	expect(actions.send("hello", [{ path: "notes/a.png" }])).toBe(true);
	expect(actions.set({ mode: "plan" })).toBe(true);
	expect(actions.interrupt()).toBe(true);
	expect(actions.answerQuestion("q1", { "Which?": "A" })).toBe(true);
	expect(actions.answerQuestion("q1", { "Which?": "A" }, { "Which?": "n" })).toBe(true);
	expect(actions.answerPermission("p1", "allow")).toBe(true);
	// A path outside the project never leaves the browser.
	expect(actions.send("x", [{ path: "../etc/passwd" }])).toBe(false);
	expect(sent).toEqual([
		{ type: "send", text: "hello", attachments: [{ path: "notes/a.png" }] },
		{ type: "set", mode: "plan" },
		{ type: "interrupt" },
		{ type: "question.answer", id: "q1", answers: { "Which?": "A" } },
		{
			type: "question.answer",
			id: "q1",
			answers: { "Which?": "A" },
			notes: { "Which?": "n" },
		},
		{ type: "permission.answer", id: "p1", optionId: "allow" },
	]);
});

test("a closed socket reports that nothing was sent", () => {
	const store = createChatStore(() => false);
	expect(store.getState().send("hello", [])).toBe(false);
});

test("a new socket waits for its own snapshot", () => {
	const clock = vi.fn(() => 0);
	const store = createChatStore(() => true, clock);
	const actions = store.getState();
	actions.receive(snapshot(0));
	actions.receive(frame("text.delta", 1, { messageId: "a1", text: "one" }));
	actions.setConnection("open");
	expect(store.getState().awaitingSnapshot).toBe(true);
	// The reconnected socket's events wait, then follow its snapshot.
	actions.receive(frame("text.delta", 6, { messageId: "a2", text: "two" }));
	expect(texts(store.getState())).toEqual(["one"]);
	actions.receive(
		snapshot(5, { messages: [{ id: "a1", role: "assistant", markdown: "one" }] }),
	);
	expect(texts(store.getState())).toEqual(["one", "two"]);
	expect(store.getState().connection).toBe("open");
});
