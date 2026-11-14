import { describe, expect, test } from "vitest";
import { ChatClientMessage, ChatServerEvent } from "./chat.js";
import {
	HANDOFF_CONTINUE_LINE,
	HANDOFF_PROMPT,
	HANDOFF_TOKENS,
	handoffFirstMessage,
	isHandoffFirstMessage,
	MAX_HANDOFF_NOTE_CHARS,
} from "./handoff-note.js";

/** Starting fresh from a handoff note (SPEC.md §10.8). */

const SESSION = "00000000-0000-4000-8000-000000000001";
const ID = "11111111-1111-4111-8111-111111111111";
const PATH = ".portikus/handoffs/2026-11-14T10-20-30Z.md";

describe("handoff messages", () => {
	test("the review and the divider parse, and only a path under .portikus/handoffs/ does", () => {
		const envelope = { sessionId: SESSION, seq: 3 };
		const review = { id: ID, path: PATH, markdown: "## Goal\n\nShip it." };
		expect(
			ChatServerEvent.safeParse({ type: "handoff.review", ...envelope, review })
				.success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse({ type: "handoff.review", ...envelope, review: null })
				.success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse({
				type: "handoff.review",
				...envelope,
				review: { ...review, path: "../../etc/passwd" },
			}).success,
		).toBe(false);
		expect(
			ChatServerEvent.safeParse({
				type: "handoff.fresh",
				...envelope,
				id: ID,
				path: PATH,
				failed: true,
			}).success,
		).toBe(true);
		expect(
			ChatServerEvent.safeParse({
				type: "handoff.fresh",
				...envelope,
				id: ID,
				path: ".portikus/handoffs/../x.md",
			}).success,
		).toBe(false);
	});

	test("the browser's handoff messages parse, and a note past the cap does not", () => {
		for (const message of [
			{ type: "handoff.start" },
			{ type: "handoff.continue", id: ID },
			{ type: "handoff.cancel", id: ID },
			{ type: "handoff.resend", id: ID },
			{ type: "handoff.edit", id: ID, markdown: "edited" },
		]) {
			expect(ChatClientMessage.safeParse(message).success).toBe(true);
		}
		expect(ChatClientMessage.safeParse({ type: "handoff.continue" }).success).toBe(
			false,
		);
		expect(
			ChatClientMessage.safeParse({
				type: "handoff.edit",
				id: ID,
				markdown: "x".repeat(MAX_HANDOFF_NOTE_CHARS + 1),
			}).success,
		).toBe(false);
		// A browser never names the file to write.
		expect(
			ChatClientMessage.safeParse({
				type: "handoff.edit",
				id: ID,
				markdown: "",
				path: PATH,
			}).success,
		).toBe(false);
	});

	test("the first message carries the note, then its path, then what to do, and is recognised", () => {
		const text = handoffFirstMessage(PATH, "## Goal\n\nShip it.\n");
		expect(text).toBe(
			`## Goal\n\nShip it.\n\nThis handoff note is saved at ${PATH}.\n\n${HANDOFF_CONTINUE_LINE}`,
		);
		expect(isHandoffFirstMessage(text)).toBe(true);
		expect(isHandoffFirstMessage("Continue from Next steps.")).toBe(false);
		expect(isHandoffFirstMessage(`Hello\n\n${HANDOFF_CONTINUE_LINE}`)).toBe(false);
	});
});

describe("automatic handoff messages", () => {
	const envelope = { sessionId: SESSION, seq: 4 };

	test("the notice parses with a saved path and its note, and nothing else", () => {
		const notice = {
			type: "handoff.auto",
			...envelope,
			id: ID,
			path: PATH,
			markdown: "## Goal",
		};
		expect(ChatServerEvent.safeParse(notice).success).toBe(true);
		expect(
			ChatServerEvent.safeParse({ ...notice, path: "../../etc/passwd" }).success,
		).toBe(false);
		expect(ChatServerEvent.safeParse({ ...notice, id: "not-a-uuid" }).success).toBe(
			false,
		);
		expect(
			ChatServerEvent.safeParse({
				...notice,
				markdown: "x".repeat(MAX_HANDOFF_NOTE_CHARS + 1),
			}).success,
		).toBe(false);
	});

	test("starting fresh from a notice may carry the student's message and files", () => {
		const bare = { type: "handoff.auto.continue", id: ID };
		expect(ChatClientMessage.safeParse(bare).success).toBe(true);
		expect(
			ChatClientMessage.safeParse({
				...bare,
				text: "Now add tests",
				attachments: [{ path: "src/a.ts" }],
			}).success,
		).toBe(true);
		expect(ChatClientMessage.safeParse({ ...bare, text: "" }).success).toBe(false);
		expect(ChatClientMessage.safeParse({ ...bare, path: PATH }).success).toBe(false);
		expect(
			ChatClientMessage.safeParse({ ...bare, attachments: [{ path: "/etc/passwd" }] })
				.success,
		).toBe(false);
	});

	test("the note prompt and the fresh chat's handoff size are shared constants", () => {
		expect(HANDOFF_TOKENS).toBe(8000);
		expect(HANDOFF_PROMPT).toContain("## Next steps");
	});
});
