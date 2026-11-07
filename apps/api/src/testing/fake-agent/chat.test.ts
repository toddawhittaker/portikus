import { ChatServerEvent } from "@portikus/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { type FakeAgent, startFakeAgent } from "./index.js";

/** Every frame the fake chat sends must be one the contract accepts (SPEC.md §9.7). */

const TOKEN = "fake-chat-token";
const ID = "550e8400-e29b-41d4-a716-446655440000";
let agent: FakeAgent;

beforeAll(async () => {
	agent = await startFakeAgent(TOKEN);
	await fetch(`http://127.0.0.1:${agent.port}/terminals`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({
			id: ID,
			cwd: "/home/student",
			theme: "dark",
			timezone: "UTC",
			agent: "claude",
			kind: "chat",
		}),
	});
});

afterAll(async () => {
	await agent.close();
});

function connect(): Promise<{ ws: WebSocket; frames: string[] }> {
	const ws = new WebSocket(`ws://127.0.0.1:${agent.port}/terminals/${ID}/chat`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	const frames: string[] = [];
	ws.on("message", (data) => frames.push(data.toString()));
	return new Promise((resolve) => ws.once("open", () => resolve({ ws, frames })));
}

const types = (frames: string[]) => frames.map((one) => JSON.parse(one).type as string);

test("the scripted turn, an answer, a send, set and interrupt all validate", async () => {
	const first = await connect();
	const second = await connect();
	await expect.poll(() => types(first.frames).includes("turn.finished")).toBe(true);
	expect(types(first.frames)).toEqual([
		"snapshot",
		"turn.started",
		"text.delta",
		"text.delta",
		"text.delta",
		"message",
		"tool.started",
		"tool.output",
		"tool.output",
		"tool.finished",
		"question.requested",
		"permission.requested",
		"turn.finished",
	]);
	// The second attachment sees the open cards in its snapshot.
	await expect.poll(() => second.frames.length).toBeGreaterThan(0);
	const snapshot = JSON.parse(second.frames[0] ?? "");
	expect(snapshot.cards.map((card: { id: string }) => card.id)).toEqual([
		"card-question",
		"card-permission",
	]);
	expect(snapshot.truncated).toBe(false);

	first.ws.send(
		JSON.stringify({
			type: "question.answer",
			id: "card-question",
			answers: { a: "b" },
		}),
	);
	await expect
		.poll(() => types(second.frames).filter((one) => one === "card.resolved").length)
		.toBe(1);
	// A second answer to the same card is ignored.
	second.ws.send(
		JSON.stringify({
			type: "question.answer",
			id: "card-question",
			answers: { a: "c" },
		}),
	);
	first.ws.send(JSON.stringify({ type: "send", text: "hello", attachments: [] }));
	first.ws.send(JSON.stringify({ type: "set", effort: "high" }));
	first.ws.send(JSON.stringify({ type: "interrupt" }));
	await expect
		.poll(() => types(first.frames).filter((one) => one === "turn.finished").length)
		.toBe(2);
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);

	for (const frame of [...first.frames, ...second.frames]) {
		expect(ChatServerEvent.safeParse(JSON.parse(frame)).success, frame).toBe(true);
	}
	expect(types(first.frames).filter((one) => one === "card.resolved")).toHaveLength(1);

	const reply = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${ID}/answers`,
	);
	expect(((await reply.json()) as { answers: unknown[] }).answers).toEqual([
		{ type: "question.answer", id: "card-question", answers: { a: "b" } },
	]);
	first.ws.close();
	second.ws.close();
});
