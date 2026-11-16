import { describe, expect, test } from "vitest";
import {
	AssistantBatchInput,
	AssistantClientMessage,
	AssistantServerEvent,
	batchConfirmText,
	CreateConversationRequest,
	MAX_ASSISTANT_BATCH_ROWS,
} from "./assistant.js";
import { ChatClientMessage, ChatServerEvent } from "./chat.js";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const card = {
	type: "permission.requested",
	sessionId,
	seq: 3,
	id: "card-1",
	toolName: "users.disable",
	title: "Disable a user",
	input: { userId: "u1" },
	options: [
		{ id: "allow", label: "Approve", decision: "allowed" },
		{ id: "deny", label: "Deny", decision: "denied" },
	],
};

describe("risk and confirmText on permission cards", () => {
	test("a student chat card without them parses and gains no fields", () => {
		const parsed = ChatServerEvent.parse(card);
		expect("risk" in parsed).toBe(false);
		expect("confirmText" in parsed).toBe(false);
	});

	test("an assistant card carries them, and the chat store's schema reads it too", () => {
		const event = { ...card, risk: "destructive", confirmText: "users.disable" };
		expect(AssistantServerEvent.parse(event)).toEqual(event);
		expect(ChatServerEvent.parse(event)).toEqual(event);
	});

	test("an unknown risk is refused", () => {
		expect(ChatServerEvent.safeParse({ ...card, risk: "never" }).success).toBe(false);
	});

	test("a student answer without confirmation parses unchanged", () => {
		const answer = { type: "permission.answer", id: "card-1", optionId: "allow" };
		expect(ChatClientMessage.parse(answer)).toEqual(answer);
	});
});

describe("AssistantServerEvent", () => {
	test("refuses chat events the assistant never sends", () => {
		expect(
			AssistantServerEvent.safeParse({ type: "question.requested", sessionId, seq: 1 })
				.success,
		).toBe(false);
	});
});

describe("AssistantClientMessage", () => {
	test("every message is also a chat client message, so the chat store sends it", () => {
		const messages = [
			{ type: "send", text: "list users", attachments: [] },
			{ type: "permission.answer", id: "c", optionId: "allow", confirmation: "30" },
			{ type: "interrupt" },
		];
		for (const message of messages) {
			expect(AssistantClientMessage.parse(message)).toEqual(message);
			expect(ChatClientMessage.parse(message)).toEqual(message);
		}
	});

	test("refuses attachments and an empty message", () => {
		expect(
			AssistantClientMessage.safeParse({
				type: "send",
				text: "x",
				attachments: [{ path: "a.png" }],
			}).success,
		).toBe(false);
		expect(
			AssistantClientMessage.safeParse({ type: "send", text: "", attachments: [] })
				.success,
		).toBe(false);
	});
});

describe("CreateConversationRequest", () => {
	test("course and context are optional", () => {
		expect(CreateConversationRequest.parse({})).toEqual({});
		expect(
			CreateConversationRequest.parse({
				courseId: sessionId,
				context: { kind: "job", id: "42" },
			}),
		).toBeTruthy();
	});

	test("refuses an unknown context kind and a course that is not a uuid", () => {
		expect(
			CreateConversationRequest.safeParse({ context: { kind: "user" } }).success,
		).toBe(false);
		expect(CreateConversationRequest.safeParse({ courseId: "7" }).success).toBe(false);
	});
});

describe("AssistantBatchInput", () => {
	const rows = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ email: `s${i}@x.edu` }));

	test("takes up to 100 rows, and the confirm text is the row count", () => {
		const batch = AssistantBatchInput.parse({
			operation: "invitations.create",
			rows: rows(MAX_ASSISTANT_BATCH_ROWS),
		});
		expect(batchConfirmText(batch)).toBe("100");
	});

	test("refuses 101 rows and none", () => {
		expect(
			AssistantBatchInput.safeParse({ operation: "x", rows: rows(101) }).success,
		).toBe(false);
		expect(AssistantBatchInput.safeParse({ operation: "x", rows: [] }).success).toBe(
			false,
		);
	});
});
