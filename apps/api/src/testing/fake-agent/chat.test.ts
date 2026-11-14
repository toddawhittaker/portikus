import { ChatServerEvent } from "@portikus/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { type FakeAgent, startFakeAgent } from "./index.js";

/** Every frame the fake chat sends must be one the contract accepts (SPEC.md §9.7). */

const TOKEN = "fake-chat-token";
const ID = "550e8400-e29b-41d4-a716-446655440000";
let agent: FakeAgent;

/** A fresh chat of its own, so a test that answers its cards leaves the others alone. */
async function newChat(
	id: string,
	codingAgent: "claude" | "codex" = "claude",
): Promise<void> {
	await fetch(`http://127.0.0.1:${agent.port}/terminals`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({
			id,
			cwd: "/home/student",
			theme: "dark",
			timezone: "UTC",
			agent: codingAgent,
			kind: "chat",
		}),
	});
}

beforeAll(async () => {
	agent = await startFakeAgent(TOKEN);
	await newChat(ID);
});

afterAll(async () => {
	await agent.close();
});

function connect(id = ID): Promise<{ ws: WebSocket; frames: string[] }> {
	const ws = new WebSocket(`ws://127.0.0.1:${agent.port}/terminals/${id}/chat`, {
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
		"mcp",
		"models",
		"modes",
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

test("the model list is sent before the settings, and a test can replace it for every attachment", async () => {
	const first = await connect();
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);
	const listed = first.frames
		.map((one) => JSON.parse(one))
		.find((e) => e.type === "models");
	expect(
		listed.models.some((m: { value: string }) => m.value === "claude-opus-4-8"),
	).toBe(true);
	const replaced = [
		{
			value: "default",
			displayName: "Default",
			description: "Whatever Claude Code picks",
			supportsAutoMode: false,
		},
	];
	const response = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${ID}/models`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ models: replaced }),
		},
	);
	expect(response.status).toBe(204);
	await expect
		.poll(() => types(first.frames).filter((one) => one === "models").length)
		.toBe(2);
	expect(JSON.parse(first.frames.at(-1) ?? "").models).toEqual(replaced);
	first.ws.close();
	// Put the list back for the tests after this one.
	await fetch(`http://127.0.0.1:${agent.port}/__test/chats/${ID}/models`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ models: listed.models }),
	});
});

for (const [optionId, decision] of [
	["allow", "allowed"],
	["always", "allowedAlways"],
	["deny", "denied"],
] as const) {
	test(`answering a permission card with ${optionId} sends ${decision}, and a later attachment gets it after the history`, async () => {
		const chatId = `550e8400-e29b-41d4-a716-44665544${optionId === "allow" ? "0001" : optionId === "always" ? "0002" : "0003"}`;
		await newChat(chatId);
		const first = await connect(chatId);
		const second = await connect(chatId);
		await expect.poll(() => types(second.frames).includes("settings")).toBe(true);
		send(first.ws, "start");
		await expect.poll(() => types(first.frames).at(-1)).toBe("turn.finished");
		first.ws.send(
			JSON.stringify({ type: "permission.answer", id: "card-permission", optionId }),
		);
		await expect
			.poll(() => types(second.frames).filter((one) => one === "card.resolved").length)
			.toBe(1);
		const resolved = second.frames
			.map((one) => JSON.parse(one))
			.find((one) => one.type === "card.resolved");
		expect(resolved).toMatchObject({ id: "card-permission", decision });

		const late = await connect(chatId);
		await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
		const lateTypes = types(late.frames);
		expect(lateTypes.filter((one) => one === "card.resolved")).toHaveLength(1);
		expect(lateTypes.indexOf("card.resolved")).toBeGreaterThan(
			lateTypes.lastIndexOf("tool.started"),
		);
		for (const frame of late.frames) {
			expect(ChatServerEvent.safeParse(JSON.parse(frame)).success, frame).toBe(true);
		}
		expect(
			JSON.parse(late.frames.find((one) => one.includes('"card.resolved"')) ?? ""),
		).toMatchObject({ id: "card-permission", decision });
		for (const one of [first, second, late]) one.ws.close();
	});
}

test("a question answer carries no decision, and /clear forgets them", async () => {
	const chatId = "550e8400-e29b-41d4-a716-446655440004";
	await newChat(chatId);
	const first = await connect(chatId);
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);
	send(first.ws, "start");
	await expect.poll(() => types(first.frames).at(-1)).toBe("turn.finished");
	first.ws.send(
		JSON.stringify({
			type: "question.answer",
			id: "card-question",
			answers: { a: "b" },
		}),
	);
	first.ws.send(
		JSON.stringify({
			type: "permission.answer",
			id: "card-permission",
			optionId: "allow",
		}),
	);
	await expect
		.poll(() => types(first.frames).filter((one) => one === "card.resolved").length)
		.toBe(2);
	const resolved = first.frames
		.map((one) => JSON.parse(one))
		.filter((one) => one.type === "card.resolved");
	expect(resolved[0]).not.toHaveProperty("decision");
	expect(resolved[1]).toMatchObject({ decision: "allowed" });

	send(first.ws, "/clear");
	await expect
		.poll(() => types(first.frames).filter((one) => one === "snapshot").length)
		.toBe(2);
	const late = await connect(chatId);
	await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
	expect(types(late.frames)).not.toContain("card.resolved");
	first.ws.close();
	late.ws.close();
});

test("the permission card offers Allow once, Always allow and Deny, and an unknown option leaves it open", async () => {
	const chatId = "550e8400-e29b-41d4-a716-446655440005";
	await newChat(chatId);
	const first = await connect(chatId);
	await expect.poll(() => types(first.frames).includes("settings")).toBe(true);
	send(first.ws, "start");
	await expect.poll(() => types(first.frames).at(-1)).toBe("turn.finished");
	const permission = first.frames
		.map((one) => JSON.parse(one))
		.find((one) => one.type === "permission.requested");
	expect(permission.options.map((option: { id: string }) => option.id)).toEqual([
		"allow",
		"always",
		"deny",
	]);

	first.ws.send(
		JSON.stringify({
			type: "permission.answer",
			id: "card-permission",
			optionId: "bogus",
		}),
	);
	first.ws.send(
		JSON.stringify({
			type: "permission.answer",
			id: "card-permission",
			optionId: "deny",
		}),
	);
	await expect
		.poll(() => types(first.frames).filter((one) => one === "card.resolved").length)
		.toBe(1);
	const reply = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${chatId}/answers`,
	);
	expect(((await reply.json()) as { answers: unknown[] }).answers).toEqual([
		{ type: "permission.answer", id: "card-permission", optionId: "deny" },
	]);
	first.ws.close();
});

type Event = ChatServerEvent;
type Of<T extends Event["type"]> = Extract<Event, { type: T }>;

/** Every frame of a list, read through the contract. */
const parsed = (frames: string[]): Event[] =>
	frames.map((one) => ChatServerEvent.parse(JSON.parse(one)));

/** The first event of a type; a test that needs one fails when it is missing. */
function first_<T extends Event["type"]>(events: Event[], type: T): Of<T> {
	const found = events.find((one): one is Of<T> => one.type === type);
	if (!found) throw new Error(`no ${type} event`);
	return found;
}

function all_<T extends Event["type"]>(events: Event[], type: T): Of<T>[] {
	return events.filter((one): one is Of<T> => one.type === type);
}

/** A chat of its own for one agent, attached and waiting for its settings. */
async function attached(id: string, codingAgent: "claude" | "codex") {
	await newChat(id, codingAgent);
	const chat = await connect(id);
	await expect.poll(() => types(chat.frames).includes("settings")).toBe(true);
	return chat;
}

const decisions = (options: { decision?: string }[]) =>
	options.map((option) => option.decision);

const CLAUDE_CHAT = "550e8400-e29b-41d4-a716-446655440010";
const CODEX_CHAT = "550e8400-e29b-41d4-a716-446655440011";

test("a Claude chat sends its five modes, its skills, and its MCP servers before the settings", async () => {
	const chat = await attached(CLAUDE_CHAT, "claude");
	const events = parsed(chat.frames);
	const { modes } = first_(events, "modes");
	expect(modes.map((mode) => mode.id)).toEqual([
		"default",
		"acceptEdits",
		"plan",
		"auto",
		"bypassPermissions",
	]);
	expect(modes.map((mode) => mode.label)).toEqual([
		"Ask",
		"Accept edits",
		"Plan",
		"Auto",
		"Bypass",
	]);
	expect(modes.filter((mode) => mode.warning).map((mode) => mode.id)).toEqual([
		"bypassPermissions",
	]);
	expect(modes.filter((mode) => mode.plan).map((mode) => mode.id)).toEqual(["plan"]);

	const { commands } = first_(events, "commands");
	expect(commands.find((one) => one.name === "pdf")).toMatchObject({
		prefix: "/",
		terminalOnly: false,
	});
	expect(commands.find((one) => one.name === "mcp")).toMatchObject({
		terminalOnly: false,
	});
	const { servers } = first_(events, "mcp");
	expect(servers.length).toBeGreaterThan(1);
	expect(servers[0]).toMatchObject({ status: "connected" });

	const order = types(chat.frames);
	expect(order.indexOf("commands")).toBeLessThan(order.indexOf("mcp"));
	expect(order.indexOf("modes")).toBeLessThan(order.indexOf("settings"));
	expect(first_(events, "settings")).toMatchObject({
		agent: "claude",
		mode: "default",
	});
	chat.ws.close();
});

test("a Claude chat shows a skill row and an MCP tool row with its card on 'demo mcp' only", async () => {
	const id = "550e8400-e29b-41d4-a716-446655440012";
	const chat = await attached(id, "claude");
	send(chat.ws, "start");
	await expect.poll(() => types(chat.frames).at(-1)).toBe("turn.finished");
	const earlier = all_(parsed(chat.frames), "tool.started");
	expect(earlier.map((one) => one.name)).toEqual(["Read", "AskUserQuestion", "Bash"]);

	const before = chat.frames.length;
	send(chat.ws, "demo mcp");
	await expect
		.poll(() => types(chat.frames).filter((one) => one === "turn.finished").length)
		.toBe(3);
	const demo = parsed(chat.frames.slice(before));
	const rows = all_(demo, "tool.started");
	expect(rows.map((one) => one.name)).toEqual(["Skill", "mcp__github__search_issues"]);
	expect(rows[0]?.input).toEqual({ skill: "pdf" });
	const card = first_(demo, "permission.requested");
	expect(card).toMatchObject({
		toolName: "mcp__github__search_issues",
		id: rows[1]?.id,
	});
	expect(decisions(card.options)).toEqual(["allowed", "allowedAlways", "denied"]);
	expect(first_(demo, "error").message).toMatch(/terminal/i);

	chat.ws.send(
		JSON.stringify({ type: "permission.answer", id: card.id, optionId: "always" }),
	);
	await expect
		.poll(() => types(chat.frames).filter((one) => one === "card.resolved").length)
		.toBe(1);
	expect(first_(parsed(chat.frames), "card.resolved")).toMatchObject({
		id: card.id,
		decision: "allowedAlways",
	});
	chat.ws.close();
});

test("every button on the default Claude cards carries its decision", async () => {
	const id = "550e8400-e29b-41d4-a716-446655440013";
	const chat = await attached(id, "claude");
	send(chat.ws, "start");
	await expect.poll(() => types(chat.frames).at(-1)).toBe("turn.finished");
	const card = first_(parsed(chat.frames), "permission.requested");
	expect(card.options.map((option) => [option.id, option.decision])).toEqual([
		["allow", "allowed"],
		["always", "allowedAlways"],
		["deny", "denied"],
	]);
	chat.ws.close();
});

test("a Codex chat lists models with efforts, its five modes, and its skills with a $ prefix", async () => {
	const chat = await attached(CODEX_CHAT, "codex");
	const events = parsed(chat.frames);
	expect(first_(events, "settings")).toMatchObject({
		agent: "codex",
		model: "gpt-5.5",
		effort: "medium",
		mode: "onRequest",
	});

	const { models } = first_(events, "models");
	for (const model of models) {
		expect(model.efforts).toContain(model.defaultEffort);
	}
	expect(models.some((model) => model.efforts?.includes("ultra"))).toBe(true);
	expect(models.some((model) => model.value === "gpt-5.5")).toBe(true);

	const { modes } = first_(events, "modes");
	expect(modes.map((mode) => mode.id)).toEqual([
		"untrusted",
		"readOnly",
		"plan",
		"onRequest",
		"fullAccess",
	]);
	expect(modes.map((mode) => mode.label)).toEqual([
		"Ask",
		"Read only",
		"Plan",
		"Auto",
		"Full access",
	]);
	expect(modes.filter((mode) => mode.warning).map((mode) => mode.id)).toEqual([
		"fullAccess",
	]);
	expect(modes.filter((mode) => mode.plan).map((mode) => mode.id)).toEqual(["plan"]);

	const { commands } = first_(events, "commands");
	expect(commands.filter((one) => one.prefix === "$").length).toBeGreaterThan(0);
	for (const name of ["model", "effort", "permissions", "plan", "mcp", "review"]) {
		expect(commands.find((one) => one.name === name)).toMatchObject({
			terminalOnly: false,
		});
	}
	for (const name of [
		"resume",
		"fork",
		"status",
		"diff",
		"init",
		"plugins",
		"logout",
	]) {
		expect(commands.find((one) => one.name === name)).toMatchObject({
			terminalOnly: true,
		});
	}
	expect(first_(events, "mcp").servers.length).toBeGreaterThan(0);
	chat.ws.close();
});

test("a Codex chat's first turn uses the Codex tool shapes and opens every kind of card", async () => {
	const id = "550e8400-e29b-41d4-a716-446655440014";
	const chat = await attached(id, "codex");
	send(chat.ws, "start");
	await expect.poll(() => types(chat.frames).at(-1)).toBe("turn.finished");
	const events = parsed(chat.frames);
	const rows = all_(events, "tool.started");
	const named = (name: string) => rows.filter((one) => one.name === name);
	expect([...new Set(rows.map((one) => one.name))]).toEqual([
		"commandExecution",
		"fileChange",
		"webSearch",
		"imageView",
		"collabAgentToolCall",
		"planSteps",
		"mcpToolCall",
		"plan",
	]);
	const kinds = named("commandExecution").flatMap(
		(one) => (one.input as { actions: { type: string }[] }).actions,
	);
	expect(kinds.map((action) => action.type)).toEqual(["read", "search"]);
	expect(named("fileChange")[0]?.input).toMatchObject({
		changes: [
			{ path: "src/answer.ts", kind: "update", diff: expect.stringContaining("@@") },
		],
	});
	expect(named("mcpToolCall")[0]?.input).toEqual({
		server: "github",
		tool: "search_issues",
		arguments: expect.any(Object),
	});
	expect(named("collabAgentToolCall")[0]?.input).toMatchObject({
		tool: "spawnAgent",
		receivers: [expect.any(String)],
	});
	expect(named("planSteps")[0]?.input).toMatchObject({
		steps: [{ step: expect.any(String), status: "completed" }, {}, {}],
	});

	const permissions = all_(events, "permission.requested");
	const mcp = permissions.find((one) => one.toolName === "mcpToolCall");
	const plan = permissions.find((one) => one.plan !== undefined);
	const question = first_(events, "question.requested");
	if (!mcp || !plan) throw new Error("missing card");
	expect(mcp.id).toBe(named("mcpToolCall")[0]?.id);
	expect(decisions(mcp.options)).toEqual(["allowed", "allowedAlways", "denied"]);
	expect(plan.plan?.length).toBeGreaterThan(0);
	// As the real host: the plan card's decision lands on its own row.
	expect(named("plan")[0]).toMatchObject({ id: plan.id, input: { plan: plan.plan } });
	expect(plan.options.map((option) => option.id)).toEqual([
		"implement-auto",
		"implement-ask",
		"keep-planning",
	]);
	expect(decisions(plan.options)).toEqual(["allowed", "allowed", "denied"]);
	const [freeText, secret] = question.questions;
	if (!freeText || !secret) throw new Error("missing question");
	expect(freeText.options).toEqual([]);
	expect(secret).toMatchObject({ options: [], secret: true });
	expect(first_(events, "error").message).toMatch(/terminal/i);

	// A later attachment sees all three cards open.
	const late = await connect(id);
	await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
	expect(first_(parsed(late.frames), "snapshot").cards.map((card) => card.id)).toEqual(
		expect.arrayContaining([mcp.id, plan.id, question.id]),
	);

	// Allow for this chat is the session decision, and an answered question
	// leaves no tool output behind because it had no row.
	chat.ws.send(
		JSON.stringify({ type: "permission.answer", id: mcp.id, optionId: "session" }),
	);
	chat.ws.send(
		JSON.stringify({
			type: "question.answer",
			id: question.id,
			answers: { [freeText.question]: "main", [secret.question]: "s3cret" },
		}),
	);
	await expect
		.poll(() => types(chat.frames).filter((one) => one === "card.resolved").length)
		.toBe(2);
	const resolved = all_(parsed(chat.frames), "card.resolved");
	expect(resolved[0]).toMatchObject({ id: mcp.id, decision: "allowedAlways" });
	expect(resolved[1]).not.toHaveProperty("decision");
	expect(
		all_(parsed(chat.frames), "tool.output").filter((one) => one.id === question.id),
	).toEqual([]);

	// The plan's answer finishes its row and lands its decision there.
	chat.ws.send(
		JSON.stringify({
			type: "permission.answer",
			id: plan.id,
			optionId: "implement-ask",
		}),
	);
	await expect
		.poll(() =>
			all_(parsed(chat.frames), "tool.finished").some((one) => one.id === plan.id),
		)
		.toBe(true);
	expect(all_(parsed(chat.frames), "card.resolved").at(-1)).toMatchObject({
		id: plan.id,
		decision: "allowed",
	});
	late.ws.close();
	chat.ws.close();
});

test("a Codex chat's second send is a canned reply, and a settings change keeps the agent", async () => {
	const id = "550e8400-e29b-41d4-a716-446655440015";
	const chat = await attached(id, "codex");
	send(chat.ws, "one");
	await expect.poll(() => types(chat.frames).at(-1)).toBe("turn.finished");
	const before = chat.frames.length;
	send(chat.ws, "two");
	chat.ws.send(JSON.stringify({ type: "set", effort: "ultra", mode: "plan" }));
	await expect
		.poll(() => types(chat.frames).filter((one) => one === "settings").length)
		.toBe(2);
	const later = parsed(chat.frames.slice(before));
	expect(first_(later, "settings")).toMatchObject({
		agent: "codex",
		effort: "ultra",
		mode: "plan",
	});
	expect(all_(later, "tool.started")).toEqual([]);
	chat.ws.close();
});

test("a test can replace the MCP list for every attachment", async () => {
	const id = "550e8400-e29b-41d4-a716-446655440016";
	const chat = await attached(id, "codex");
	const servers = [{ name: "docs", status: "needsAuth" }];
	const response = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${id}/mcp`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ servers }),
		},
	);
	expect(response.status).toBe(204);
	await expect
		.poll(() => types(chat.frames).filter((one) => one === "mcp").length)
		.toBe(2);
	expect(JSON.parse(chat.frames.at(-1) ?? "").servers).toEqual(servers);
	const late = await connect(id);
	await expect.poll(() => types(late.frames).includes("settings")).toBe(true);
	expect(first_(parsed(late.frames), "mcp").servers).toEqual(servers);
	late.ws.close();
	chat.ws.close();
});
