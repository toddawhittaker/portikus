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

const send = (ws: WebSocket, text: string) =>
	ws.send(JSON.stringify({ type: "send", text, attachments: [] }));

test("an attach replays the earlier turn and ends with settings, and starts nothing", async () => {
	const first = await connect();
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);
	first.ws.close();
	expect(types(first.frames)).toEqual([
		"snapshot",
		"turn.started",
		"message",
		"message",
		"turn.finished",
		"commands",
		"settings",
	]);
	const snapshot = JSON.parse(first.frames[0] ?? "");
	expect(snapshot).not.toHaveProperty("messages");
	const turn = first.frames.map((one) => JSON.parse(one));
	expect(turn[1].at).toBeLessThan(turn[4].at);
	expect(turn[4].status).toBe("done");
});

test("the command list is sent on attach and a test can replace it for every attachment", async () => {
	const first = await connect();
	await expect.poll(() => types(first.frames).includes("commands")).toBe(true);
	const listed = first.frames
		.map((one) => JSON.parse(one))
		.find((e) => e.type === "commands");
	expect(listed.commands.some((c: { terminalOnly: boolean }) => c.terminalOnly)).toBe(
		true,
	);

	const replaced = [{ name: "deploy", description: "Ship it", terminalOnly: false }];
	const response = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${ID}/commands`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ commands: replaced }),
		},
	);
	expect(response.status).toBe(204);
	await expect
		.poll(() => types(first.frames).filter((one) => one === "commands").length)
		.toBe(2);
	expect(JSON.parse(first.frames.at(-1) ?? "").commands).toEqual(replaced);
	const late = await connect();
	await expect.poll(() => types(late.frames).includes("commands")).toBe(true);
	expect(
		JSON.parse(late.frames.find((f) => JSON.parse(f).type === "commands") ?? "")
			.commands,
	).toEqual(replaced);
	late.ws.close();
	first.ws.close();
	// Put the default back for the tests after this one.
	await fetch(`http://127.0.0.1:${agent.port}/__test/chats/${ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ commands: listed.commands }),
	});
});

test("the first send runs the scripted turn; later attachments replay it", async () => {
	const first = await connect();
	const second = await connect();
	await expect.poll(() => types(second.frames).includes("settings")).toBe(true);
	send(first.ws, "start");
	await expect
		.poll(() => types(first.frames).includes("permission.requested"))
		.toBe(true);
	await expect.poll(() => types(first.frames).at(-1)).toBe("turn.finished");

	const late = await connect();
	await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
	const lateTypes = types(late.frames);
	expect(lateTypes).toContain("tool.started");
	expect(lateTypes).not.toContain("permission.requested");
	expect(lateTypes.at(-1)).toBe("settings");
	const snapshot = JSON.parse(late.frames[0] ?? "");
	expect(snapshot.cards.map((card: { id: string }) => card.id)).toEqual([
		"card-question",
		"card-permission",
	]);
	late.ws.close();
	second.ws.close();
	first.ws.close();
});

test("an answer, a send, set and interrupt all validate", async () => {
	const first = await connect();
	const second = await connect();
	await expect.poll(() => types(second.frames).includes("settings")).toBe(true);
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
	const before = types(first.frames).filter((one) => one === "turn.finished").length;
	send(first.ws, "hello");
	first.ws.send(JSON.stringify({ type: "set", effort: "high" }));
	first.ws.send(JSON.stringify({ type: "interrupt" }));
	await expect
		.poll(() => types(first.frames).filter((one) => one === "turn.finished").length)
		.toBe(before + 2);
	await expect
		.poll(() => types(first.frames).filter((one) => one === "settings").length)
		.toBe(2);

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

test("a test can set the context figures; every attachment and later ones get them", async () => {
	const first = await connect();
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);
	expect(types(first.frames)).not.toContain("context");
	const figures = {
		usedTokens: 144000,
		windowTokens: 200000,
		cache: { at: Date.now(), ttlSeconds: 300 },
	};
	const response = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${ID}/context`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(figures),
		},
	);
	expect(response.status).toBe(204);
	await expect.poll(() => types(first.frames).includes("context")).toBe(true);
	expect(JSON.parse(first.frames.at(-1) ?? "")).toMatchObject(figures);
	const late = await connect();
	await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
	expect(
		JSON.parse(late.frames.find((f) => JSON.parse(f).type === "context") ?? ""),
	).toMatchObject(figures);
	late.ws.close();
	first.ws.close();
});
