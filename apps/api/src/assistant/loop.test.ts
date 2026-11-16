import { describe, expect, test } from "vitest";
import { openCards } from "./hub.js";
import { rebuildMessages } from "./loop.js";
import type { StoredEvent } from "./store.js";

/** The model's messages come from our own stored events, never the SDK's format (SPEC.md section 20.4). */

const user = (markdown: string): StoredEvent => ({
	type: "message",
	id: `u-${markdown}`,
	role: "user",
	markdown,
});
const said = (markdown: string): StoredEvent => ({
	type: "message",
	id: `a-${markdown}`,
	role: "assistant",
	markdown,
});
const started = (id: string, input: unknown = {}): StoredEvent => ({
	type: "tool.started",
	id,
	name: "users_list",
	title: "t",
	input: input as never,
});
const out = (id: string, text: string): StoredEvent => ({
	type: "tool.output",
	id,
	part: { type: "text", text },
});
const done = (id: string, isError = false): StoredEvent => ({
	type: "tool.finished",
	id,
	isError,
});

describe("rebuilding the model's messages", () => {
	test("a step's text and calls are one message, followed by their results", () => {
		const messages = rebuildMessages([
			{ type: "turn.started", at: 1 },
			user("hi"),
			said("Looking."),
			started("c1", { query: {} }),
			started("c2"),
			out("c1", "one"),
			out("c1", " more"),
			done("c1"),
			out("c2", "bad"),
			done("c2", true),
			started("c3"),
			out("c3", "three"),
			done("c3"),
			said("All done."),
			{ type: "turn.finished", status: "done", at: 2 },
		]);
		expect(messages).toEqual([
			{ role: "user", text: "hi" },
			{
				role: "assistant",
				text: "Looking.",
				toolCalls: [
					{ id: "c1", name: "users_list", input: { query: {} } },
					{ id: "c2", name: "users_list", input: {} },
				],
			},
			{
				role: "tool",
				results: [
					{ id: "c1", name: "users_list", text: "one more", isError: false },
					{ id: "c2", name: "users_list", text: "bad", isError: true },
				],
			},
			{
				role: "assistant",
				text: "",
				toolCalls: [{ id: "c3", name: "users_list", input: {} }],
			},
			{
				role: "tool",
				results: [{ id: "c3", name: "users_list", text: "three", isError: false }],
			},
			{ role: "assistant", text: "All done.", toolCalls: [] },
		]);
	});

	test("a call with no result reads as not finished, and errors and cards are left out", () => {
		const messages = rebuildMessages([
			user("go"),
			started("c1"),
			{ type: "error", message: "x" },
			{ type: "turn.finished", status: "interrupted", at: 1 },
		]);
		expect(messages[2]).toMatchObject({
			role: "tool",
			results: [
				{ id: "c1", isError: true, text: expect.stringMatching(/did not finish/) },
			],
		});
		expect(messages).toHaveLength(3);
	});
});

describe("what a stored history says", () => {
	const card: StoredEvent = {
		type: "permission.requested",
		id: "c1",
		toolName: "users_disable",
		title: "Stops one person",
		input: {},
		options: [{ id: "approve", label: "Approve", decision: "allowed" }],
		risk: "destructive",
		confirmText: "users.disable",
	};

	test("a card is open until resolved", () => {
		expect(openCards([card])).toEqual([{ ...card, type: "permission" }]);
		expect(openCards([card, { type: "card.resolved", id: "c1" }])).toEqual([]);
	});
});
