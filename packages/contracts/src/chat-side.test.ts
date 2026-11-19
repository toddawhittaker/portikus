import { describe, expect, test } from "vitest";
import { ChatClientMessage, ChatServerEvent } from "./chat.js";
import { MAX_CHAT_SIDE_TEXT_CHARS, SideAskMessage, SideExchange } from "./chat-side.js";
import * as contracts from "./index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

describe("side client messages", () => {
	const ask = (text: unknown, extra: object = {}) => ({
		type: "side.ask",
		text,
		...extra,
	});

	test("a question of 4,000 characters is accepted and 4,001 is refused", () => {
		expect(MAX_CHAT_SIDE_TEXT_CHARS).toBe(4000);
		expect(ChatClientMessage.safeParse(ask("a".repeat(4000))).success).toBe(true);
		expect(ChatClientMessage.safeParse(ask("a".repeat(4001))).success).toBe(false);
	});

	test("an empty or blank question is refused", () => {
		expect(ChatClientMessage.safeParse(ask("")).success).toBe(false);
		expect(ChatClientMessage.safeParse(ask("  \n\t ")).success).toBe(false);
	});

	test("the text is kept as typed, not trimmed", () => {
		const parsed = SideAskMessage.parse(ask("  why?  "));
		expect(parsed.text).toBe("  why?  ");
	});

	test("a missing or non-string text is refused", () => {
		expect(ChatClientMessage.safeParse({ type: "side.ask" }).success).toBe(false);
		expect(ChatClientMessage.safeParse(ask(7)).success).toBe(false);
	});

	test("unknown fields are refused, as for the other client frames", () => {
		expect(ChatClientMessage.safeParse(ask("hi", { attachments: [] })).success).toBe(
			false,
		);
		expect(ChatClientMessage.safeParse({ type: "side.stop", extra: 1 }).success).toBe(
			false,
		);
		expect(ChatClientMessage.safeParse({ type: "side.end", extra: 1 }).success).toBe(
			false,
		);
	});

	test("stop and end are part of the client union", () => {
		expect(ChatClientMessage.safeParse({ type: "side.stop" }).success).toBe(true);
		expect(ChatClientMessage.safeParse({ type: "side.end" }).success).toBe(true);
		expect(ChatClientMessage.safeParse(ask("hi")).success).toBe(true);
	});
});

describe("side host frame", () => {
	const frame = (extra: object = {}) => ({
		type: "side",
		sessionId: SESSION,
		event: {
			type: "text.delta",
			sessionId: SESSION,
			seq: 3,
			messageId: "m1",
			text: "Because",
		},
		...extra,
	});

	test("carries a subagent event and is part of the host frame union", () => {
		const parsed = ChatServerEvent.safeParse(frame());
		expect(parsed.success).toBe(true);
		expect(parsed.data).toMatchObject({ type: "side", event: { type: "text.delta" } });
	});

	test("needs no sequence number of its own", () => {
		expect(ChatServerEvent.safeParse(frame()).success).toBe(true);
	});

	test("may mark the end of the conversation, and only with true", () => {
		const ended = frame({
			ended: true,
			event: {
				type: "snapshot",
				sessionId: SESSION,
				seq: 0,
				cards: [],
				turnRunning: false,
				truncated: false,
			},
		});
		expect(ChatServerEvent.safeParse(ended).success).toBe(true);
		expect(ChatServerEvent.safeParse(frame({ ended: false })).success).toBe(false);
	});

	test("refuses an event a subagent conversation cannot carry", () => {
		const bad = frame({
			event: { type: "permission.requested", sessionId: SESSION, seq: 1 },
		});
		expect(ChatServerEvent.safeParse(bad).success).toBe(false);
	});

	test("refuses a frame with no session or no event", () => {
		expect(ChatServerEvent.safeParse(frame({ sessionId: undefined })).success).toBe(
			false,
		);
		expect(ChatServerEvent.safeParse(frame({ event: undefined })).success).toBe(false);
	});
});

describe("SideExchange", () => {
	test("holds a question and its answer", () => {
		expect(
			SideExchange.safeParse({ question: "why?", answer: "because" }).success,
		).toBe(true);
		expect(SideExchange.safeParse({ question: "why?" }).success).toBe(false);
	});

	test("is reachable from the package index", () => {
		expect(contracts.SideExchange).toBe(SideExchange);
		expect(contracts.MAX_CHAT_SIDE_TEXT_CHARS).toBe(4000);
	});
});
