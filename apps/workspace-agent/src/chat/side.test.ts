import type { ChatSubagentEvent, SideExchange } from "@portikus/contracts";
import { MAX_CHAT_SIDE_TEXT_CHARS } from "@portikus/contracts";
import { describe, expect, test, vi } from "vitest";
import type { ChatAgent, SideEventBody } from "./agent.js";
import {
	SIDE_BUSY_MESSAGE,
	SIDE_TOO_LONG_MESSAGE,
	SIDE_UNAVAILABLE_MESSAGE,
	SideConversation,
	sideCommand,
} from "./side.js";

const ID = "00000000-0000-4000-8000-000000000001";

interface Call {
	text: string;
	earlier: SideExchange[];
	emit: (e: SideEventBody) => void;
	signal: AbortSignal;
	finish: () => void;
	fail: (error: Error) => void;
}

function setup(withSide = true) {
	const calls: Call[] = [];
	const ended: number[] = [];
	const agent = {
		...(withSide
			? {
					askSide: (
						text: string,
						earlier: SideExchange[],
						emit: Call["emit"],
						signal: AbortSignal,
					) =>
						new Promise<void>((resolve, reject) => {
							calls.push({
								text,
								earlier,
								emit,
								signal,
								finish: resolve,
								fail: reject,
							});
						}),
					endSide: async () => {
						ended.push(1);
					},
				}
			: {}),
	} as unknown as ChatAgent;
	const lines: string[] = [];
	const side = new SideConversation({
		terminalId: ID,
		agent,
		broadcast: (line) => lines.push(line),
	});
	const events = () =>
		lines.map((line) => (JSON.parse(line) as { event: ChatSubagentEvent }).event);
	const settled = () =>
		vi.waitFor(() => expect(events().at(-1)?.type).toBe("turn.finished"));
	return { side, calls, ended, lines, events, settled };
}

function answer(call: Call, markdown: string) {
	call.emit({
		type: "message",
		id: "a",
		role: "assistant",
		markdown,
	});
}

describe("sideCommand", () => {
	test("tells a side question, a bare /btw and other text apart", () => {
		expect(sideCommand("/btw")).toBe("open");
		expect(sideCommand("  /btw   ")).toBe("open");
		expect(sideCommand("/btw what is x?")).toEqual({ question: "what is x?" });
		expect(sideCommand("/btw\nwhat is x?")).toEqual({ question: "what is x?" });
		expect(sideCommand("/btw\twhat is\nx?")).toEqual({ question: "what is\nx?" });
		expect(sideCommand("/btw\n")).toBe("open");
		expect(sideCommand("/btwx")).toBeNull();
		expect(sideCommand("hello /btw")).toBeNull();
		expect(sideCommand("/clear")).toBeNull();
	});
});

describe("a side conversation", () => {
	test("frames carry no chat seq and number the side's own events from a snapshot", async () => {
		const { side, calls, lines, events } = setup();
		side.ask("q1");
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		answer(calls[0] as Call, "a1");
		calls[0]?.finish();
		await vi.waitFor(() => expect(events().at(-1)?.type).toBe("turn.finished"));
		const frame = JSON.parse(lines[0] as string);
		expect(frame).toMatchObject({ type: "side", sessionId: ID });
		expect(frame.seq).toBeUndefined();
		expect(events().map((e) => [e.type, e.seq])).toEqual([
			["snapshot", 0],
			["turn.started", 1],
			["message", 2],
			["message", 3],
			["turn.finished", 4],
		]);
		expect(events()[2]).toMatchObject({ role: "user", markdown: "q1" });
		expect(events()[3]).toMatchObject({
			role: "assistant",
			markdown: "a1",
			sessionId: ID,
		});
		expect(events()[4]).toMatchObject({ status: "done" });
	});

	test("one question at a time: a second ask is refused, not queued", async () => {
		const { side, calls, events, settled } = setup();
		side.ask("q1");
		side.ask("q2");
		// The refusal is a side message, not a throw the core would put in the main chat.
		expect(events().at(-1)).toMatchObject({
			type: "message",
			role: "assistant",
			markdown: SIDE_BUSY_MESSAGE,
		});
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		calls[0]?.finish();
		await settled();
		expect(calls).toHaveLength(1);
		side.ask("q3");
		await vi.waitFor(() => expect(calls).toHaveLength(2));
	});

	test("the next question gets the earlier exchanges", async () => {
		const { side, calls, settled } = setup();
		side.ask("q1");
		answer(calls[0] as Call, "a1");
		calls[0]?.finish();
		await settled();
		side.ask("q2");
		expect(calls[1]?.earlier).toEqual([{ question: "q1", answer: "a1" }]);
	});

	test("stop aborts the signal and ends the turn interrupted; the conversation stays", async () => {
		const { side, calls, events } = setup();
		side.ask("q1");
		side.stop();
		expect(calls[0]?.signal.aborted).toBe(true);
		calls[0]?.finish();
		await vi.waitFor(() =>
			expect(events().at(-1)).toMatchObject({
				type: "turn.finished",
				status: "interrupted",
			}),
		);
		expect(side.replay().length).toBeGreaterThan(0);
		side.ask("q2");
		// A stopped question is not an exchange to carry on from.
		expect(calls[1]?.earlier).toEqual([]);
	});

	test("a driver error shows as the answer, before the failed turn closes", async () => {
		const { side, calls, events, settled } = setup();
		side.ask("q1");
		answer(calls[0] as Call, "part");
		calls[0]?.fail(new Error("Claude Code is too old."));
		await settled();
		expect(events().map((e) => e.type)).toEqual([
			"snapshot",
			"turn.started",
			"message",
			"message",
			"message",
			"turn.finished",
		]);
		expect(events().at(-2)).toMatchObject({
			role: "assistant",
			markdown: "Claude Code is too old.",
		});
		expect(events().at(-1)).toMatchObject({ status: "error" });
	});

	test("an error without a message shows the general failure", async () => {
		const { side, calls, events, settled } = setup();
		side.ask("q1");
		calls[0]?.fail(new Error(""));
		await settled();
		expect(events().at(-2)).toMatchObject({
			markdown: expect.stringMatching(/did not get an answer/),
		});
		// A failed question is not an exchange to carry on from.
		side.ask("q2");
		expect(calls[1]?.earlier).toEqual([]);
	});

	test("the core opens the turn and shows the question before the driver answers", () => {
		const { side, calls, events } = setup();
		side.ask("q1");
		expect(calls).toHaveLength(1);
		expect(events().map((e) => e.type)).toEqual([
			"snapshot",
			"turn.started",
			"message",
		]);
		expect(events()[2]).toMatchObject({ role: "user", markdown: "q1" });
	});

	test("end forgets everything, calls endSide, tells attachments, and drops a late answer", async () => {
		const { side, calls, ended, events } = setup();
		side.ask("q1");
		await side.end();
		expect(calls[0]?.signal.aborted).toBe(true);
		expect(ended).toHaveLength(1);
		expect(events().at(-1)).toMatchObject({
			type: "snapshot",
			seq: 0,
			turnRunning: false,
		});
		const count = events().length;
		answer(calls[0] as Call, "late");
		calls[0]?.finish();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events()).toHaveLength(count);
		expect(side.replay()).toEqual([]);
		// Ending nothing tells nobody.
		await side.end();
		expect(ended).toHaveLength(1);
		expect(events()).toHaveLength(count);
	});

	test("an end while the question is still starting sends the empty snapshot and calls endSide", async () => {
		const { side, calls, ended, events } = setup();
		side.ask("q1");
		expect(calls).toHaveLength(1);
		await side.end();
		expect(ended).toHaveLength(1);
		expect(events().at(-1)).toMatchObject({ type: "snapshot", turnRunning: false });
		calls[0]?.fail(new Error("late"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events().at(-1)).toMatchObject({ type: "snapshot" });
	});

	test("replay is a snapshot showing whether a question runs, then every event", async () => {
		const { side, calls } = setup();
		expect(side.replay()).toEqual([]);
		side.ask("q1");
		answer(calls[0] as Call, "part");
		const replayed = side.replay().map((line) => JSON.parse(line).event);
		expect(replayed.map((e: ChatSubagentEvent) => e.type)).toEqual([
			"snapshot",
			"turn.started",
			"message",
			"message",
		]);
		expect(replayed[0]).toMatchObject({ turnRunning: true });
	});

	test("refuses without a driver that answers, and over-long text, in side frames outside any turn", () => {
		const none = setup(false);
		none.side.ask("q");
		expect(none.events().map((e) => e.type)).toEqual(["snapshot", "message"]);
		expect(none.events()[1]).toMatchObject({ markdown: SIDE_UNAVAILABLE_MESSAGE });
		const long = setup();
		long.side.ask("x".repeat(MAX_CHAT_SIDE_TEXT_CHARS + 1));
		expect(long.calls).toEqual([]);
		expect(long.events().map((e) => e.type)).toEqual(["snapshot", "message"]);
		expect(long.events()[1]).toMatchObject({ markdown: SIDE_TOO_LONG_MESSAGE });
		// A refusal is not a question to carry on from.
		long.side.ask("short");
		expect(long.calls[0]?.earlier).toEqual([]);
	});

	test("only the end of the conversation is marked ended", async () => {
		const { side, calls, lines } = setup();
		side.ask("q1");
		answer(calls[0] as Call, "a1");
		const frames = () => lines.map((line) => JSON.parse(line));
		expect(frames().some((frame) => "ended" in frame)).toBe(false);
		expect(side.replay().some((line) => "ended" in JSON.parse(line))).toBe(false);
		await side.end();
		expect(frames().at(-1)).toMatchObject({
			type: "side",
			sessionId: ID,
			ended: true,
			event: { type: "snapshot", seq: 0, turnRunning: false, cards: [] },
		});
		expect(frames().filter((frame) => frame.ended)).toHaveLength(1);
		// The next conversation's first ask is not an end.
		side.ask("q2");
		expect(frames().at(-1)).not.toHaveProperty("ended");
	});
});
