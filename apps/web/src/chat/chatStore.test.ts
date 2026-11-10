import type { ChatClientMessage, ChatServerEvent } from "@portikus/contracts";
import { expect, test, vi } from "vitest";
import {
	type ChatState,
	changeToward,
	createChatStore,
	initialChatState,
	isNewChat,
	lastSettingsOf,
	modelChoice,
	receiveChatEvent,
	receiveChatFrame,
	selectSessionRulesActive,
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

test("events that arrive before the snapshot are dropped", () => {
	const state = feed([
		frame("text.delta", 3, { messageId: "m1", text: " world" }),
		snapshot(4),
		frame("text.delta", 5, { messageId: "m1", text: "Hello" }),
	]);
	expect(state.loaded).toBe(true);
	expect(texts(state)).toEqual(["Hello"]);
	expect(state.lastSeq).toBe(5);
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

test("history is built only from the events replayed after the snapshot, with real times", () => {
	const state = feed([
		snapshot(10),
		frame("turn.started", 11, { at: 50_000 }),
		frame("message", 12, { id: "u1", role: "user", markdown: "Earlier question" }),
		frame("message", 13, { id: "a1", role: "assistant", markdown: "Earlier answer" }),
		frame("turn.finished", 14, { at: 273_000, status: "interrupted" }),
	]);
	expect(texts(state)).toEqual(["Earlier question", "Earlier answer"]);
	const [turn] = Object.values(state.turns);
	// The replayed turn keeps its length although it arrived in one burst.
	expect(turn).toMatchObject({
		startedAt: 50_000,
		finishedAt: 273_000,
		status: "interrupted",
	});
	expect(state.lastUserMessageSeq).toBe(12);
});

test("a turn running at attach takes its start time from the replayed turn.started", () => {
	let state = feed([snapshot(1, { turnRunning: true })], initialChatState, 9_000);
	const estimated = state.currentTurnId ?? "";
	expect(state.turns[estimated]).toMatchObject({ startedAt: 9_000, estimated: true });
	state = feed([frame("turn.started", 2, { at: 4_000 })], state, 9_000);
	expect(state.currentTurnId).toBe(estimated);
	expect(Object.keys(state.turns)).toEqual([estimated]);
	expect(state.turns[estimated]).toMatchObject({ startedAt: 4_000, estimated: false });
});

test("a repeated tool.started updates the block instead of adding a second", () => {
	const started = { id: "t1", name: "Bash", title: "ls", input: { command: "ls" } };
	const state = feed([
		snapshot(0),
		frame("tool.started", 1, started),
		frame("tool.started", 2, { ...started, title: "ls -la" }),
	]);
	expect(state.items).toHaveLength(1);
	expect(state.items[0]).toMatchObject({ kind: "tool", title: "ls -la" });
});

test("a tool its turn ended without finishing shows as done or stopped, never running", () => {
	const turn = (seq: number, status: "done" | "interrupted" | "error") => [
		frame("turn.started", seq, { at: 0 }),
		frame("tool.started", seq + 1, {
			id: `t${seq}`,
			name: "Bash",
			title: "",
			input: {},
		}),
		frame("turn.finished", seq + 2, { at: 1, status }),
	];
	const state = feed([
		snapshot(0),
		...turn(1, "done"),
		...turn(4, "interrupted"),
		...turn(7, "error"),
	]);
	expect(state.items.map((item) => item.kind === "tool" && item.status)).toEqual([
		"done",
		"stopped",
		"stopped",
	]);
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
		snapshot(2, {
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
		frame("message", 3, { id: "a9", role: "assistant", markdown: "restored" }),
	]);
	expect(texts(state)).toEqual(["restored"]);
	expect(state.cards.map((card) => card.id)).toEqual(["p1"]);
	expect(state.truncated).toBe(true);
});

test("a turn streams, runs a tool, and finishes with its times", () => {
	let state = feed([snapshot(0)], initialChatState, 0);
	state = receiveChatFrame(state, frame("turn.started", 1, { at: 1_000 }), 1_000);
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
		frame("turn.finished", 8, { at: 224_000, status: "done" }),
		5,
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

/** A turn running `pnpm build`, as the host replays it, at 1 s. */
function buildingTurn(): ChatState {
	return feed(
		[
			snapshot(0),
			frame("message", 1, { id: "u1", role: "user", markdown: "Build it" }),
			frame("turn.started", 2, { at: 1_000 }),
			frame("tool.started", 3, {
				id: "t1",
				name: "Bash",
				title: "pnpm build",
				input: { command: "pnpm build" },
			}),
		],
		initialChatState,
		1_000,
	);
}

function sendWhileBuilding(state: ChatState): ChatState {
	return feed(
		[frame("message", 4, { id: "u2", role: "user", markdown: "Skip the docs" })],
		state,
		5_000,
	);
}

test("a message sent while Claude works is marked, and the work after it is a new turn", () => {
	let state = buildingTurn();
	const first = state.currentTurnId as string;
	state = sendWhileBuilding(state);
	expect(state.items.at(-1)).toMatchObject({
		kind: "message",
		id: "u2",
		role: "user",
		markdown: "Skip the docs",
		turnId: null,
		whileWorking: true,
	});
	expect(state.lastUserMessageSeq).toBe(4);
	state = feed(
		[
			frame("tool.finished", 5, { id: "t1", isError: false }),
			frame("text.delta", 6, { messageId: "a1", text: "Skipping" }),
		],
		state,
		7_000,
	);
	const next = state.currentTurnId as string;
	expect(next).not.toBe(first);
	// Claude took the message in at its next step, so that is where the turns divide.
	expect(state.turns[first]).toMatchObject({ finishedAt: 7_000, status: "done" });
	expect(state.turns[next]).toMatchObject({
		startedAt: 7_000,
		finishedAt: null,
		status: "running",
	});
	state = feed(
		[frame("turn.finished", 7, { at: 9_000, status: "done" })],
		state,
		9_000,
	);
	expect(state.items.find((item) => item.key === "tool:t1")).toMatchObject({
		turnId: first,
		status: "done",
	});
	expect(state.items.at(-1)).toMatchObject({ turnId: next, streaming: false });
	expect(state.turns[next]).toMatchObject({ finishedAt: 9_000, status: "done" });
	expect(state.currentTurnId).toBeNull();
});

test("a tool still running when the student sends stays in the running turn", () => {
	const before = buildingTurn();
	const state = sendWhileBuilding(before);
	const turnId = before.currentTurnId as string;
	expect(state.currentTurnId).toBe(turnId);
	expect(state.turns[turnId]).toMatchObject({ status: "running", finishedAt: null });
	expect(Object.keys(state.turns)).toHaveLength(1);
	expect(state.items.find((item) => item.key === "tool:t1")).toMatchObject({
		turnId,
		status: "running",
	});
});

test.each([
	["interrupted", "stopped"],
	["error", "stopped"],
] as const)(
	"a turn that ends %s after a send keeps that status on the work it did",
	(status, tool) => {
		const before = buildingTurn();
		const turnId = before.currentTurnId as string;
		const state = feed(
			[frame("turn.finished", 5, { at: 6_000, status })],
			sendWhileBuilding(before),
			6_000,
		);
		expect(state.currentTurnId).toBeNull();
		expect(Object.keys(state.turns)).toEqual([turnId]);
		expect(state.turns[turnId]).toMatchObject({ finishedAt: 6_000, status });
		expect(state.items.find((item) => item.key === "tool:t1")).toMatchObject({
			turnId,
			status: tool,
		});
		// The next turn is an ordinary one, not a split left waiting.
		const after = feed(
			[
				frame("turn.started", 6, { at: 7_000 }),
				frame("text.delta", 7, { messageId: "a2", text: "Again" }),
			],
			state,
			7_000,
		);
		expect(after.currentTurnId).toBe("turn-6");
		expect(after.items.at(-1)).toMatchObject({ turnId: "turn-6" });
	},
);

test("a second message sent before Claude takes in the first opens one new turn", () => {
	let state = sendWhileBuilding(buildingTurn());
	state = feed(
		[
			frame("message", 5, { id: "u3", role: "user", markdown: "And lint" }),
			frame("tool.started", 6, {
				id: "t2",
				name: "Bash",
				title: "pnpm lint",
				input: { command: "pnpm lint" },
			}),
		],
		state,
		6_000,
	);
	expect(Object.keys(state.turns)).toHaveLength(2);
	expect(state.items.at(-1)).toMatchObject({ key: "tool:t2", turnId: "turn-4" });
});

test("a message sent before Claude shows any work, or replayed, is not marked", () => {
	const state = feed([
		snapshot(0),
		frame("message", 1, { id: "u1", role: "user", markdown: "one" }),
		frame("turn.started", 2, { at: 1_000 }),
		frame("message", 3, { id: "u2", role: "user", markdown: "two" }),
		frame("message", 4, { id: "a1", role: "assistant", markdown: "ok" }),
		frame("turn.finished", 5, { at: 2_000, status: "done" }),
		// A replayed turn sends turn.started before its message.
		frame("turn.started", 6, { at: 3_000 }),
		frame("message", 7, { id: "u3", role: "user", markdown: "three" }),
	]);
	expect(Object.keys(state.turns)).toHaveLength(2);
	for (const item of state.items) {
		expect(item.kind === "message" && item.whileWorking).toBeFalsy();
	}
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
	expect(state.lastError).toEqual({ seq: 2, message: "Claude Code is not signed in" });
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
	// Until the new snapshot the old conversation stays, and nothing is applied.
	actions.receive(frame("text.delta", 6, { messageId: "a2", text: "two" }));
	expect(texts(store.getState())).toEqual(["one"]);
	actions.receive(snapshot(5));
	actions.receive(
		frame("message", 6, { id: "a1", role: "assistant", markdown: "one" }),
	);
	actions.receive(frame("text.delta", 7, { messageId: "a2", text: "two" }));
	expect(texts(store.getState())).toEqual(["one", "two"]);
	expect(store.getState().connection).toBe("open");
});

test("the command list the host reports is kept, replaced by the next, and survives a new snapshot", () => {
	const first = [
		{ name: "compact", description: "Shrink", terminalOnly: false },
		{ name: "config", description: "Settings", terminalOnly: true },
	];
	let state = feed([snapshot(1)]);
	expect(state.commands).toEqual([]);
	state = feed([frame("commands", 2, { commands: first })], state);
	expect(state.commands).toEqual(first);
	state = feed([snapshot(3)], state);
	expect(state.commands).toEqual(first);
	const next = [{ name: "review", description: "Review", terminalOnly: false }];
	state = feed([frame("commands", 4, { commands: next })], state);
	expect(state.commands).toEqual(next);
});

test("the session rules the host reports are kept, and revoking one sends it", () => {
	const rule = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };
	let state = feed([snapshot(1), frame("rules", 2, { rules: [rule] })]);
	expect(state.sessionRules).toEqual([rule]);
	expect(selectSessionRulesActive(state)).toBe(true);
	state = feed([frame("rules", 3, { rules: [] })], state);
	expect(selectSessionRulesActive(state)).toBe(false);

	const sent: ChatClientMessage[] = [];
	const store = createChatStore((message) => {
		sent.push(message);
		return true;
	});
	expect(store.getState().revokeRule("Bash(sed:*)")).toBe(true);
	expect(store.getState().revokeRule("")).toBe(false);
	expect(sent).toEqual([{ type: "rule.revoke", rule: "Bash(sed:*)" }]);
});

/** The settings a new chat starts with in the host (SPEC.md §10.8). */
function startSettings(seq: number): string {
	return frame("settings", seq, {
		agent: "claude",
		model: "default",
		effort: "high",
		mode: "default",
	});
}

test("a chat with no turns at the host's start values is new; anything else is not", () => {
	expect(isNewChat(initialChatState)).toBe(false);
	const fresh = feed([snapshot(1), startSettings(2)]);
	expect(isNewChat(fresh)).toBe(true);
	const changed = feed(
		[
			frame("settings", 3, {
				agent: "claude",
				model: "opus",
				effort: "high",
				mode: "default",
			}),
		],
		fresh,
	);
	expect(isNewChat(changed)).toBe(false);
	const used = feed([
		snapshot(1),
		frame("turn.started", 2, { at: 1000 }),
		startSettings(3),
	]);
	expect(isNewChat(used)).toBe(false);
});

test("the change toward the last-used values names only what differs", () => {
	const start = {
		agent: "claude" as const,
		model: "default",
		effort: "high" as const,
		mode: "default" as const,
	};
	expect(changeToward(start, { model: "opus", effort: "high", mode: "auto" })).toEqual({
		model: "opus",
		mode: "auto",
	});
	expect(
		changeToward(start, { model: "default", effort: "high", mode: "default" }),
	).toBeNull();
	expect(
		changeToward(
			{ ...start, model: "claude-opus-4-1" },
			{ model: "opus", effort: "low", mode: "default" },
		),
	).toEqual({ effort: "low" });
});

test("what is kept is the picker's model choice and the host's effort and mode", () => {
	expect(
		lastSettingsOf({
			agent: "claude",
			model: "claude-haiku-4-5",
			effort: "max",
			mode: "bypassPermissions",
		}),
	).toEqual({ model: "haiku", effort: "max", mode: "bypassPermissions" });
	expect(modelChoice("something-new")).toBe("default");
	expect(modelChoice("sonnet")).toBe("sonnet");
});

const SHELL = {
	id: "sh-1",
	command: "ls -la",
	output: "",
	exitCode: null,
	truncated: false,
	state: "running",
} as const;

test("a shell event adds a shell item that the same id then finishes", () => {
	const state = feed([
		snapshot(0),
		frame("shell", 1, SHELL),
		frame("shell", 2, {
			...SHELL,
			output: "total 0\n",
			exitCode: 0,
			state: "done",
		}),
	]);
	expect(state.items).toEqual([
		{
			kind: "shell",
			key: "shell:sh-1",
			id: "sh-1",
			command: "ls -la",
			output: "total 0\n",
			exitCode: 0,
			truncated: false,
			state: "done",
			turnId: null,
		},
	]);
});

test("a shell command is never part of a turn, even one running", () => {
	const state = feed([
		snapshot(0),
		frame("turn.started", 1, { at: 5 }),
		frame("shell", 2, SHELL),
	]);
	expect(state.items).toMatchObject([{ kind: "shell", turnId: null }]);
	expect(state.currentTurnId).not.toBeNull();
});

test("shell items replayed after a snapshot are kept, and a new snapshot starts them over", () => {
	const done = { ...SHELL, output: "a\n", exitCode: 1, state: "done" } as const;
	const first = feed([snapshot(0), frame("shell", 1, done)]);
	expect(first.items).toHaveLength(1);
	const again = feed([snapshot(5), frame("shell", 6, done)], first);
	expect(again.items).toMatchObject([{ id: "sh-1", exitCode: 1, state: "done" }]);
	expect(again.items).toHaveLength(1);
});

test("a shell item keeps its place among the messages around it", () => {
	const state = feed([
		snapshot(0),
		frame("message", 1, { id: "u1", role: "user", markdown: "hi" }),
		frame("shell", 2, SHELL),
		frame("message", 3, { id: "u2", role: "user", markdown: "next" }),
		frame("shell", 4, { ...SHELL, state: "done", exitCode: 0, output: "x" }),
	]);
	expect(state.items.map((item) => item.kind)).toEqual(["message", "shell", "message"]);
});

test("the latest context event is kept per tab, and a new snapshot clears it", () => {
	const first = {
		usedTokens: 1200,
		windowTokens: 200000,
		cache: { at: 1000, ttlSeconds: 300 as const },
	};
	let state = feed([snapshot(1)]);
	expect(state.context).toBeNull();
	state = feed([frame("context", 2, first)], state);
	expect(state.context).toEqual({ ...first, clockOffsetMs: 0 });
	const next = { usedTokens: 5000, windowTokens: null, cache: null };
	state = feed([frame("context", 3, next)], state);
	expect(state.context).toEqual({ ...next, clockOffsetMs: 0 });
	state = feed([snapshot(4)], state);
	expect(state.context).toBeNull();
});
