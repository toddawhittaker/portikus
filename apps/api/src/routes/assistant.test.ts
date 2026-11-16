/**
 * The built-in assistant's routes and loop (SPEC.md sections 20.4, 24.1 and
 * 24.11), end to end through the WebSocket with a scripted fake model: reads
 * run as the person, changes wait for an approval card claimed once, limits
 * stop the loop, and nothing from a conversation reaches the log.
 */
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	AI_NOTICE_VERSION,
	type AssistantServerEvent,
	CloseCode,
	type ConversationSummary,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	type TestDb,
} from "@portikus/db/testing";
import { createLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { createFakeModelClient, type FakeStep } from "../ai/fake-model.js";
import {
	type ModelClient,
	ModelError,
	type ModelErrorCode,
	type ModelPart,
	type StepRequest,
} from "../ai/model.js";
import { sealAiKey, unavailableMessage } from "../ai/settings.js";
import { LIMIT_TEXT } from "../assistant/budget.js";
import { REFUSED_TEXT } from "../assistant/cards.js";
import { systemPrompt } from "../assistant/tools.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
	testConfig,
} from "../testing/test-support.js";

const model = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../ai/model.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ai/model.js")>()),
	createModelClient: () => model.client,
}));

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let logLines: string[] = [];
const ORIGIN = new URL(PUBLIC_URL).origin;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

async function enableAssistant(extra: Record<string, unknown> = {}): Promise<void> {
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: true,
			provider_kind: "openai-compatible",
			base_url: "https://api.openai.com/v1",
			model: "gpt-test",
			key_sealed: sealAiKey(testConfig(mock.issuer), "sk-test-key-1234"),
			key_hint: "1234",
			monthly_token_cap: 5_000_000,
			conversation_token_budget: 200_000,
			notice_version: AI_NOTICE_VERSION,
			...extra,
		})
		.execute();
}

beforeEach(async () => {
	if (skip) return;
	// First: deleting two users would null both users' usage rows into a duplicate.
	await testDb.db.deleteFrom("ai_usage_days").execute();
	await testDb.truncate();
	await enableAssistant();
	model.client = null;
	logLines = [];
});

async function server(): Promise<FastifyInstance> {
	const app = buildTestServer(
		testDb.db,
		mock.issuer,
		{},
		createLogger({
			service: "api",
			level: "debug",
			destination: { write: (line: string) => logLines.push(line) },
		}),
	);
	await app.listen({ port: 0, host: "127.0.0.1" });
	return app;
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
	const app = await server();
	try {
		await run(app);
	} finally {
		await app.close();
	}
}

type Person = { jar: CookieJar; id: string };

async function signIn(app: FastifyInstance, who: string): Promise<Person> {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	return { jar, id: me.json().id as string };
}

function call(
	app: FastifyInstance,
	person: Person,
	method: "GET" | "POST" | "DELETE" | "PUT",
	url: string,
	payload?: unknown,
) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(person.jar, PUBLIC_URL),
		...(payload === undefined ? {} : { payload: payload as object }),
	});
}

async function newConversation(
	app: FastifyInstance,
	person: Person,
	body: unknown = {},
): Promise<ConversationSummary> {
	const res = await call(app, person, "POST", "/assistant/conversations", body);
	expect(res.statusCode, res.body).toBe(201);
	return res.json() as ConversationSummary;
}

type Frame = AssistantServerEvent;

type Client = {
	socket: WebSocket;
	frames: Frame[];
	send: (message: unknown) => void;
	waitFor: (match: (frame: Frame) => boolean, what?: string) => Promise<Frame>;
	closed: Promise<number>;
};

function upgradeStatus(
	app: FastifyInstance,
	path: string,
	headers: Record<string, string>,
) {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
	return new Promise<number>((resolve) => {
		socket.once("open", () => {
			socket.close();
			resolve(101);
		});
		socket.once("unexpected-response", (_req, res) => {
			resolve(res.statusCode ?? 0);
			socket.terminate();
		});
		socket.once("error", () => resolve(0));
	});
}

async function connect(
	app: FastifyInstance,
	person: Person,
	id: string,
): Promise<Client> {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(
		`ws://127.0.0.1:${port}/assistant/conversations/${id}/socket`,
		{ headers: { origin: ORIGIN, cookie: person.jar.cookieHeader() } },
	);
	const frames: Frame[] = [];
	const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
	socket.on("message", (data) => {
		const frame = JSON.parse(data.toString()) as Frame;
		frames.push(frame);
		for (const waiter of [...waiters]) {
			if (waiter.match(frame)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			}
		}
	});
	const closed = new Promise<number>((resolve) =>
		socket.on("close", (code) => resolve(code)),
	);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	await new Promise<void>((resolve) => {
		const check = () => (frames.length > 0 ? resolve() : setTimeout(check, 5));
		check();
	});
	return {
		socket,
		frames,
		closed,
		send: (message) => socket.send(JSON.stringify(message)),
		waitFor: (match, what = "a frame") => {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			return new Promise<Frame>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								`timed out waiting for ${what}: ${JSON.stringify(frames.map((f) => f.type))}`,
							),
						),
					5000,
				);
				waiters.push({
					match,
					resolve: (f) => {
						clearTimeout(timer);
						resolve(f);
					},
				});
			});
		},
	};
}

const turnDone =
	(status = "done") =>
	(f: Frame) =>
		f.type === "turn.finished" && f.status === status;

/** Wait for the nth finished turn of a client (1-based). */
async function turnsFinished(client: Client, n: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			if (client.frames.filter((f) => f.type === "turn.finished").length >= n)
				resolve();
			else if (Date.now() - started > 5000)
				reject(new Error(`only ${client.frames.map((f) => f.type).join(",")}`));
			else setTimeout(check, 5);
		};
		check();
	});
}

const FINISH = (input = 10, output = 5): ModelPart => ({
	type: "finish",
	usage: { input, output, cacheRead: 0, cacheWrite: 0 },
});

const TOOLS_FINISH = (input = 10, output = 5): ModelPart => ({
	type: "finish",
	usage: { input, output, cacheRead: 0, cacheWrite: 0 },
});

function reply(text: string): ModelPart[] {
	return [{ type: "text", text }, FINISH()];
}

function toolCall(
	id: string,
	name: string,
	input: unknown,
	usage?: [number, number],
): ModelPart[] {
	return [{ type: "tool-call", id, name, input }, TOOLS_FINISH(...(usage ?? [10, 5]))];
}

function fake(steps: FakeStep[]) {
	const client = createFakeModelClient(steps);
	model.client = client;
	return client;
}

async function storedTypes(id: string): Promise<string[]> {
	const rows = await testDb.db
		.selectFrom("assistant_events")
		.select("event")
		.where("conversation_id", "=", id)
		.orderBy("seq")
		.execute();
	return rows.map((r) => (r.event as { type: string }).type);
}

async function auditOf(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

function outputOf(client: Client, id: string): string {
	return client.frames
		.filter(
			(f): f is Extract<Frame, { type: "tool.output" }> =>
				f.type === "tool.output" && f.id === id,
		)
		.map((f) => (f.part.type === "text" ? f.part.text : ""))
		.join("");
}

function lastToolResults(request: StepRequest) {
	const last = request.messages.at(-1);
	return last?.role === "tool" ? last.results : [];
}

describe.skipIf(skip)("who may use the assistant", () => {
	test("a student gets 403 on every route and on the socket upgrade", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const own = await newConversation(app, carol);
			const alice = await signIn(app, "alice");
			for (const [method, url] of [
				["GET", "/assistant/status"],
				["GET", "/assistant/conversations"],
				["POST", "/assistant/conversations"],
				["DELETE", `/assistant/conversations/${own.id}`],
			] as const) {
				const res = await call(
					app,
					alice,
					method,
					url,
					method === "POST" ? {} : undefined,
				);
				expect(res.statusCode, `${method} ${url}`).toBe(403);
			}
			expect(
				await upgradeStatus(app, `/assistant/conversations/${own.id}/socket`, {
					origin: ORIGIN,
					cookie: alice.jar.cookieHeader(),
				}),
			).toBe(403);
			expect(
				await upgradeStatus(app, `/assistant/conversations/${own.id}/socket`, {
					origin: ORIGIN,
				}),
			).toBe(401);
		}));

	test("another staff member sees none of a conversation: not listed, 404 to delete or open", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const own = await newConversation(app, carol);
			const ivy = await signIn(app, "ivy");
			const list = await call(app, ivy, "GET", "/assistant/conversations");
			expect(list.json()).toEqual({ conversations: [] });
			expect(
				(await call(app, ivy, "DELETE", `/assistant/conversations/${own.id}`))
					.statusCode,
			).toBe(404);
			expect(
				await upgradeStatus(app, `/assistant/conversations/${own.id}/socket`, {
					origin: ORIGIN,
					cookie: ivy.jar.cookieHeader(),
				}),
			).toBe(404);
			const mine = await call(app, carol, "GET", "/assistant/conversations");
			expect(mine.json().conversations.map((c: ConversationSummary) => c.id)).toEqual([
				own.id,
			]);
			expect(
				(await call(app, carol, "DELETE", `/assistant/conversations/${own.id}`))
					.statusCode,
			).toBe(204);
			expect(
				await testDb.db.selectFrom("assistant_conversations").select("id").execute(),
			).toEqual([]);
		}));

	test("the status names why it is not available, and a new conversation is refused with 409", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const status = await call(app, carol, "GET", "/assistant/status");
			expect(status.json()).toEqual({ enabled: true, reason: null });
			await enableAssistant({ notice_version: null });
			expect((await call(app, carol, "GET", "/assistant/status")).json()).toEqual({
				enabled: false,
				reason: "notice",
			});
			await enableAssistant({ enabled: false });
			const ivy = await signIn(app, "ivy");
			expect((await call(app, ivy, "GET", "/assistant/status")).json()).toEqual({
				enabled: false,
				reason: "off",
			});
			const refused = await call(app, carol, "POST", "/assistant/conversations", {});
			expect(refused.statusCode).toBe(409);
			expect(refused.json()).toMatchObject({ code: "AI_NOT_ENABLED", reason: "off" });
			expect(refused.json().message).toBe(unavailableMessage("off"));
		}));

	test("an instructor may open a conversation only for a course they teach", () =>
		withApp(async (app) => {
			const ivy = await signIn(app, "ivy");
			const taught = await insertTestLtiMembership(testDb.db, ivy.id, {
				contextId: "taught",
				role: "instructor",
			});
			const carol = await signIn(app, "carol");
			const other = await insertTestLtiMembership(testDb.db, carol.id, {
				contextId: "other",
				role: "student",
			});
			const ok = await newConversation(app, ivy, { courseId: taught });
			expect(ok).toMatchObject({
				courseId: taught,
				readOnly: false,
				title: "New conversation",
			});
			const refused = await call(app, ivy, "POST", "/assistant/conversations", {
				courseId: other,
			});
			expect(refused.statusCode).toBe(404);
			const diagnose = await newConversation(app, carol, {
				context: { kind: "health" },
			});
			expect(diagnose).toMatchObject({ readOnly: true, context: { kind: "health" } });
		}));
});

describe.skipIf(skip)("the loop", () => {
	test("a text reply is streamed, stored, counted, and replayed on reconnect", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const client = fake([reply("Hello there.")]);
			const socket = await connect(app, carol, conv.id);
			expect(socket.frames[0]).toMatchObject({
				type: "snapshot",
				seq: 0,
				cards: [],
				turnRunning: false,
			});
			socket.send({ type: "send", text: "hello\nsecond line", attachments: [] });
			await socket.waitFor(turnDone());
			expect(socket.frames.map((f) => f.type)).toEqual([
				"snapshot",
				"turn.started",
				"message",
				"text.delta",
				"message",
				"turn.finished",
			]);
			const seqs = socket.frames.slice(1).map((f) => f.seq);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
			expect(await storedTypes(conv.id)).toEqual([
				"turn.started",
				"message",
				"message",
				"turn.finished",
			]);
			expect(client.requests[0]?.messages).toEqual([
				{ role: "user", text: "hello\nsecond line" },
			]);
			expect(client.requests[0]?.system).toBe(
				systemPrompt({ role: "administrator", readOnly: false }),
			);

			const [row] = await testDb.db
				.selectFrom("assistant_conversations")
				.selectAll()
				.execute();
			expect(row?.tokens_used).toBe("15");
			expect(row?.title).toBe("hello");
			const usage = await testDb.db.selectFrom("ai_usage_days").selectAll().execute();
			expect(usage).toMatchObject([
				{
					user_id: carol.id,
					purpose: "assistant",
					model: "gpt-test",
					input_tokens: "10",
				},
			]);

			const again = await connect(app, carol, conv.id);
			await again.waitFor(turnDone());
			expect(again.frames.map((f) => f.type)).toEqual([
				"snapshot",
				"turn.started",
				"message",
				"message",
				"turn.finished",
			]);
			expect(again.frames[3]).toMatchObject({
				role: "assistant",
				markdown: "Hello there.",
			});
			socket.socket.close();
			again.socket.close();
		}));

	test("a read call runs at once as the person, answers as the route does, and is stored", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			const client = fake([
				toolCall("call-r1", "users_list", {}),
				reply("Two people."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "who is here?", attachments: [] });
			await socket.waitFor(turnDone());
			const http = await call(app, carol, "GET", "/admin/users");
			expect(JSON.parse(outputOf(socket, "call-r1"))).toEqual(http.json());
			expect(socket.frames.find((f) => f.type === "tool.started")).toMatchObject({
				id: "call-r1",
				name: "users_list",
				title: expect.stringMatching(/^Lists the people/),
			});
			expect(socket.frames.find((f) => f.type === "tool.finished")).toMatchObject({
				id: "call-r1",
				isError: false,
			});
			const second = client.requests[1];
			expect(second?.messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"tool",
			]);
			expect(lastToolResults(second as StepRequest)[0]).toMatchObject({
				id: "call-r1",
				name: "users_list",
			});
			const used = await auditOf("assistant.used");
			expect(used).toHaveLength(1);
			expect(used[0]).toMatchObject({ via: "assistant", actor: `user:${carol.id}` });
			expect(used[0]?.metadata).toMatchObject({ operation: "users.list", status: 200 });
			const row = await testDb.db
				.selectFrom("assistant_conversations")
				.select("tokens_used")
				.executeTakeFirstOrThrow();
			expect(row.tokens_used).toBe("30");
			socket.socket.close();
		}));

	test("a bad input goes back to the model as an error, with no request made", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const client = fake([
				toolCall("call-b1", "users_disable", { id: "not-a-uuid" }),
				reply("I could not."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "go", attachments: [] });
			await socket.waitFor(turnDone());
			expect(JSON.parse(outputOf(socket, "call-b1"))).toMatchObject({
				code: "VALIDATION_FAILED",
			});
			expect(lastToolResults(client.requests[1] as StepRequest)[0]?.isError).toBe(true);
			expect(
				await testDb.db.selectFrom("assistant_approvals").selectAll().execute(),
			).toEqual([]);
			expect(await auditOf("assistant.used")).toEqual([]);
			socket.socket.close();
		}));

	test("a change call draws a card and ends the turn; approved, it runs as the session", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			const input = {
				operation: "users.update_settings",
				input: { path: { id: alice.id }, body: { shutdownGraceSeconds: null } },
			};
			const client = fake([
				toolCall("call-c1", "run_operation", input),
				reply("Done."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "clear it", attachments: [] });
			const card = await socket.waitFor((f) => f.type === "permission.requested");
			await socket.waitFor(turnDone());
			expect(card).toMatchObject({
				id: "call-c1",
				toolName: "users_update_settings",
				title: expect.stringMatching(/^Sets or clears/),
				input: input.input,
				risk: "change",
				options: [
					{ id: "approve", label: "Approve", decision: "allowed" },
					{ id: "deny", label: "Deny", decision: "denied" },
				],
			});
			expect(card).not.toHaveProperty("confirmText");
			expect(client.requests).toHaveLength(1);
			expect(await auditOf("assistant.used")).toEqual([]);

			socket.send({ type: "permission.answer", id: "call-c1", optionId: "approve" });
			await turnsFinished(socket, 2);
			expect(socket.frames.find((f) => f.type === "card.resolved")).toMatchObject({
				id: "call-c1",
				decision: "allowed",
			});
			expect(JSON.parse(outputOf(socket, "call-c1"))).toMatchObject({ id: alice.id });
			const used = await auditOf("assistant.used");
			expect(used.map((r) => r.metadata)).toMatchObject([
				{ operation: "users.update_settings", status: 200 },
			]);
			const [row] = await testDb.db
				.selectFrom("assistant_approvals")
				.selectAll()
				.execute();
			expect(row).toMatchObject({
				status: "approved",
				risk: "change",
				confirm_text: null,
			});
			expect(client.requests).toHaveLength(2);
			socket.socket.close();
		}));

	test("a denied card gives the model a refused result and runs nothing", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const client = fake([
				toolCall("call-d1", "workspaces_restart", {
					path: { id: crypto.randomUUID() },
				}),
				reply("Left alone."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "restart", attachments: [] });
			await socket.waitFor(turnDone());
			socket.send({ type: "permission.answer", id: "call-d1", optionId: "deny" });
			await turnsFinished(socket, 2);
			expect(socket.frames.find((f) => f.type === "card.resolved")).toMatchObject({
				decision: "denied",
			});
			expect(outputOf(socket, "call-d1")).toBe(REFUSED_TEXT);
			expect(lastToolResults(client.requests[1] as StepRequest)[0]).toMatchObject({
				text: REFUSED_TEXT,
				isError: true,
			});
			expect(await auditOf("assistant.used")).toEqual([]);
			socket.socket.close();
		}));

	test("a destructive card needs its exact confirmation; a wrong or missing one denies", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			fake([
				toolCall("call-x1", "users_disable", { path: { id: alice.id } }),
				reply("Not done."),
				toolCall("call-x2", "users_disable", { path: { id: alice.id } }),
				reply("Not done again."),
				toolCall("call-x3", "users_disable", { path: { id: alice.id } }),
				reply("Disabled."),
			]);
			const socket = await connect(app, carol, conv.id);
			const attempt = async (n: number, answer: Record<string, unknown>) => {
				socket.send({ type: "send", text: `try ${n}`, attachments: [] });
				const card = await socket.waitFor(
					(f) => f.type === "permission.requested" && f.id === `call-x${n}`,
				);
				expect(card).toMatchObject({
					risk: "destructive",
					confirmText: "users.disable",
				});
				await turnsFinished(socket, n * 2 - 1);
				socket.send({ type: "permission.answer", id: `call-x${n}`, ...answer });
				await turnsFinished(socket, n * 2);
			};
			await attempt(1, { optionId: "approve", confirmation: "USERS.DISABLE" });
			await attempt(2, { optionId: "approve" });
			const disabled = async () =>
				(
					await testDb.db
						.selectFrom("users")
						.select("disabled_at")
						.where("id", "=", alice.id)
						.executeTakeFirstOrThrow()
				).disabled_at;
			expect(await disabled()).toBeNull();
			await attempt(3, { optionId: "approve", confirmation: "users.disable" });
			expect(await disabled()).not.toBeNull();
			const rows = await testDb.db
				.selectFrom("assistant_approvals")
				.select(["tool_call_id", "status", "confirm_text"])
				.orderBy("tool_call_id")
				.execute();
			expect(rows).toEqual([
				{ tool_call_id: "call-x1", status: "denied", confirm_text: "users.disable" },
				{ tool_call_id: "call-x2", status: "denied", confirm_text: "users.disable" },
				{ tool_call_id: "call-x3", status: "approved", confirm_text: "users.disable" },
			]);
			socket.socket.close();
		}));

	test("an answer from two tabs at once runs the call once", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			const input = {
				operation: "users.update_settings",
				input: { path: { id: alice.id }, body: { shutdownGraceSeconds: null } },
			};
			const client = fake([
				toolCall("call-t1", "run_operation", input),
				reply("Done once."),
			]);
			const one = await connect(app, carol, conv.id);
			const two = await connect(app, carol, conv.id);
			one.send({ type: "send", text: "go", attachments: [] });
			await two.waitFor((f) => f.type === "permission.requested");
			await two.waitFor(turnDone());
			const answer = { type: "permission.answer", id: "call-t1", optionId: "approve" };
			one.send(answer);
			two.send(answer);
			one.send(answer);
			await turnsFinished(one, 2);
			await new Promise((r) => setTimeout(r, 200));
			expect(await auditOf("assistant.used")).toHaveLength(1);
			expect(client.requests).toHaveLength(2);
			expect(two.frames.filter((f) => f.type === "card.resolved")).toHaveLength(1);
			one.socket.close();
			two.socket.close();
		}));

	test("an approval sent after the session was signed out is refused and runs nothing", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			fake([
				toolCall("call-s1", "users_disable", { path: { id: alice.id } }),
				reply("x"),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "go", attachments: [] });
			await socket.waitFor(turnDone());
			expect((await call(app, carol, "POST", "/auth/logout")).statusCode).toBeLessThan(
				400,
			);
			socket.send({
				type: "permission.answer",
				id: "call-s1",
				optionId: "approve",
				confirmation: "users.disable",
			});
			expect(await socket.closed).toBe(CloseCode.SESSION_ENDED);
			const [row] = await testDb.db
				.selectFrom("assistant_approvals")
				.selectAll()
				.execute();
			expect(row?.status).toBe("pending");
			expect(await auditOf("assistant.used")).toEqual([]);
		}));

	test("a message while a card waits is refused to that tab only, and not kept", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			const client = fake([
				toolCall("call-f1", "users_disable", { path: { id: alice.id } }),
				reply("Left alone."),
			]);
			const socket = await connect(app, carol, conv.id);
			const other = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "go", attachments: [] });
			await socket.waitFor(turnDone());
			socket.send({ type: "send", text: "and more", attachments: [] });
			const refused = await socket.waitFor((f) => f.type === "error");
			expect(refused).toMatchObject({
				message: expect.stringMatching(/approval card/),
			});
			// The turn the answer starts reaches the other tab, so it had its chance at the refusal.
			socket.send({ type: "permission.answer", id: "call-f1", optionId: "deny" });
			await turnsFinished(other, 2);
			expect(other.frames.some((f) => f.type === "error")).toBe(false);
			expect(await storedTypes(conv.id)).not.toContain("error");
			const again = await connect(app, carol, conv.id);
			expect(again.frames.some((f) => f.type === "error")).toBe(false);
			expect(client.requests).toHaveLength(2);
			for (const one of [socket, other, again]) one.socket.close();
		}));

	test("a step's reads run before its cards are drawn", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			fake([
				[
					{
						type: "tool-call",
						id: "call-w1",
						name: "users_disable",
						input: { path: { id: alice.id } },
					},
					{ type: "tool-call", id: "call-r1", name: "users_list", input: {} },
					TOOLS_FINISH(),
				],
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "go", attachments: [] });
			await socket.waitFor(turnDone());
			const order = socket.frames
				.filter((f) => f.type === "tool.finished" || f.type === "permission.requested")
				.map((f) => `${f.type}:${(f as { id: string }).id}`);
			expect(order).toEqual(["tool.finished:call-r1", "permission.requested:call-w1"]);
			socket.socket.close();
		}));

	for (const how of ["signed out", "disabled"] as const) {
		test(`a person ${how} mid-turn gets no further model step, and every tab is closed`, () =>
			withApp(async (app) => {
				const carol = await signIn(app, "carol");
				const conv = await newConversation(app, carol);
				const requests: StepRequest[] = [];
				model.client = {
					async *step(req) {
						requests.push(req);
						yield {
							type: "tool-call",
							id: `call-e${requests.length}`,
							name: "users_list",
							input: {},
						};
						if (how === "signed out") {
							await call(app, carol, "POST", "/auth/logout");
						} else {
							await testDb.db
								.updateTable("users")
								.set({ disabled_at: new Date().toISOString() })
								.where("id", "=", carol.id)
								.execute();
						}
						yield TOOLS_FINISH();
					},
					listModels: async () => null,
				} satisfies ModelClient;
				const socket = await connect(app, carol, conv.id);
				const other = await connect(app, carol, conv.id);
				socket.send({ type: "send", text: "go", attachments: [] });
				expect(await socket.closed).toBe(CloseCode.SESSION_ENDED);
				expect(await other.closed).toBe(CloseCode.SESSION_ENDED);
				expect(requests).toHaveLength(1);
				expect((await storedTypes(conv.id)).at(-1)).toBe("turn.finished");
			}));
	}

	test("a read-only conversation is offered no change tools and cannot reach one", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol, { context: { kind: "health" } });
			// The first reply follows the Diagnose reads that run when the socket opens.
			const client = fake([
				toolCall("call-o1", "run_operation", {
					operation: "users.disable",
					input: { path: { id: alice.id } },
				}),
				reply("I may only read."),
			]);
			const socket = await connect(app, carol, conv.id);
			await turnsFinished(socket, 2);
			const names = client.requests[0]?.tools.map((t) => t.name) ?? [];
			expect(names).toContain("users_list");
			expect(names).not.toContain("users_disable");
			expect(names).not.toContain("workspaces_restart");
			expect(client.requests[0]?.system).toBe(
				systemPrompt({ role: "administrator", readOnly: true }),
			);
			expect(JSON.parse(outputOf(socket, "call-o1"))).toMatchObject({
				code: "NOT_FOUND",
			});
			expect(
				await testDb.db.selectFrom("assistant_approvals").selectAll().execute(),
			).toEqual([]);
			socket.socket.close();
		}));

	test("the conversation budget stops the loop with a plain message", () =>
		withApp(async (app) => {
			await enableAssistant({ conversation_token_budget: 20 });
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const client = fake([toolCall("call-g1", "users_list", {}, [20, 5])]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "list", attachments: [] });
			await socket.waitFor(turnDone());
			expect(client.requests).toHaveLength(1);
			expect(socket.frames.filter((f) => f.type === "message").at(-1)).toMatchObject({
				role: "assistant",
				markdown: LIMIT_TEXT.conversation,
			});
			socket.socket.close();
		}));

	test("the site's monthly cap stops the loop between steps", () =>
		withApp(async (app) => {
			await enableAssistant({ monthly_token_cap: 30 });
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const client = fake([toolCall("call-m1", "users_list", {}, [30, 5])]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "list", attachments: [] });
			await socket.waitFor(turnDone());
			expect(client.requests).toHaveLength(1);
			expect(socket.frames.filter((f) => f.type === "message").at(-1)).toMatchObject({
				markdown: LIMIT_TEXT["monthly-cap"],
			});
			// The next message is refused before any model call.
			socket.send({ type: "send", text: "again", attachments: [] });
			const refused = await socket.waitFor((f) => f.type === "error");
			expect(refused).toMatchObject({ message: unavailableMessage("monthly-cap") });
			expect(await storedTypes(conv.id)).not.toContain("error");
			socket.socket.close();
		}));

	test("twelve steps for one message at most", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const steps = Array.from({ length: 13 }, (_, n) =>
				toolCall(`call-n${n}`, "users_list", {}, [1, 1]),
			);
			const client = fake(steps);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "loop", attachments: [] });
			await socket.waitFor(turnDone());
			expect(client.requests).toHaveLength(12);
			expect(socket.frames.filter((f) => f.type === "message").at(-1)).toMatchObject({
				markdown: LIMIT_TEXT.steps,
			});
			socket.socket.close();
		}));

	test("interrupt stops the running step; a message while a turn runs is refused", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const hanging: ModelClient = {
				async *step(req) {
					yield { type: "text", text: "Thinking" };
					await new Promise<void>((resolve) =>
						req.signal.addEventListener("abort", () => resolve()),
					);
					throw new ModelError("aborted");
				},
				listModels: async () => null,
			};
			model.client = hanging;
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "think", attachments: [] });
			await socket.waitFor((f) => f.type === "text.delta");
			socket.send({ type: "send", text: "and another", attachments: [] });
			const busy = await socket.waitFor((f) => f.type === "error");
			expect(busy).toMatchObject({ message: expect.stringMatching(/still working/) });

			const late = await connect(app, carol, conv.id);
			expect(late.frames[0]).toMatchObject({ type: "snapshot", turnRunning: true });
			await late.waitFor((f) => f.type === "text.delta" && f.text === "Thinking");

			socket.send({ type: "interrupt" });
			await socket.waitFor(turnDone("interrupted"));
			// The refusal went to the tab that sent the message, and was not kept.
			expect(late.frames.some((f) => f.type === "error")).toBe(false);
			expect(await storedTypes(conv.id)).toEqual([
				"turn.started",
				"message",
				"message",
				"turn.finished",
			]);
			const again = await connect(app, carol, conv.id);
			expect(again.frames.some((f) => f.type === "error")).toBe(false);
			socket.socket.close();
			late.socket.close();
			again.socket.close();
		}));

	test("each model error ends the turn with its own plain message", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const codes: ModelErrorCode[] = [
				"auth",
				"rate-limited",
				"unreachable",
				"bad-response",
				"other",
			];
			for (const code of codes) {
				const conv = await newConversation(app, carol);
				fake([{ error: code }]);
				const socket = await connect(app, carol, conv.id);
				socket.send({ type: "send", text: "hi", attachments: [] });
				await socket.waitFor(turnDone("error"), `error for ${code}`);
				expect(socket.frames.find((f) => f.type === "error")).toMatchObject({
					message: new ModelError(code).message,
				});
				socket.socket.close();
			}
			const lines = logLines.join("\n");
			for (const code of codes) expect(lines).toContain(`"code":"${code}"`);
		}));

	test("a pending approval survives a restart and is answered on the new server", async () => {
		await testDb.truncate();
		const first = await server();
		let conv: ConversationSummary;
		let carolJar: CookieJar;
		let aliceId: string;
		try {
			const carol = await signIn(first, "carol");
			const alice = await signIn(first, "alice");
			aliceId = alice.id;
			carolJar = carol.jar;
			conv = await newConversation(first, carol);
			fake([toolCall("call-p1", "users_disable", { path: { id: alice.id } })]);
			const socket = await connect(first, carol, conv.id);
			socket.send({ type: "send", text: "go", attachments: [] });
			await socket.waitFor(turnDone());
			socket.socket.close();
		} finally {
			await first.close();
		}
		await withApp(async (app) => {
			fake([reply("Disabled after the restart.")]);
			const carol = { jar: carolJar, id: "" };
			const socket = await connect(app, carol, conv.id);
			expect(socket.frames[0]).toMatchObject({
				type: "snapshot",
				cards: [{ type: "permission", id: "call-p1", confirmText: "users.disable" }],
			});
			socket.send({
				type: "permission.answer",
				id: "call-p1",
				optionId: "approve",
				confirmation: "users.disable",
			});
			await socket.waitFor(
				(f) => f.type === "message" && f.markdown === "Disabled after the restart.",
			);
			const row = await testDb.db
				.selectFrom("users")
				.select("disabled_at")
				.where("id", "=", aliceId)
				.executeTakeFirstOrThrow();
			expect(row.disabled_at).not.toBeNull();
			socket.socket.close();
		});
	});

	test("an instructor's tools leave out administrator operations, and answer as the routes do", () =>
		withApp(async (app) => {
			const ivy = await signIn(app, "ivy");
			const course = await insertTestLtiMembership(testDb.db, ivy.id, {
				contextId: "ivy-course",
				role: "instructor",
			});
			const conv = await newConversation(app, ivy, { courseId: course });
			const client = fake([
				[
					{ type: "tool-call", id: "call-i1", name: "courses_list", input: {} },
					{
						type: "tool-call",
						id: "call-i2",
						name: "courses_members",
						input: { path: { courseId: course } },
					},
					{
						type: "tool-call",
						id: "call-i3",
						name: "run_operation",
						input: { operation: "users.list" },
					},
					TOOLS_FINISH(),
				],
				reply("Here is your course."),
			]);
			const socket = await connect(app, ivy, conv.id);
			socket.send({ type: "send", text: "my course", attachments: [] });
			await socket.waitFor(turnDone());
			const names = client.requests[0]?.tools.map((t) => t.name) ?? [];
			expect(names).toContain("courses_list");
			expect(names.some((n) => n.startsWith("users_"))).toBe(false);
			expect(client.requests[0]?.system).toBe(
				systemPrompt({ role: "instructor", readOnly: false }),
			);
			expect(JSON.parse(outputOf(socket, "call-i1"))).toEqual(
				(await call(app, ivy, "GET", "/courses")).json(),
			);
			expect(JSON.parse(outputOf(socket, "call-i2"))).toEqual(
				(await call(app, ivy, "GET", `/courses/${course}/members`)).json(),
			);
			expect(JSON.parse(outputOf(socket, "call-i3"))).toMatchObject({
				code: "NOT_FOUND",
			});
			socket.socket.close();
		}));

	test("nothing a person wrote, the model replied or a tool returned reaches the log", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const alice = await signIn(app, "alice");
			const conv = await newConversation(app, carol);
			fake([
				[
					{ type: "text", text: "SECRET-REPLY-ONE" },
					{
						type: "tool-call",
						id: "call-l1",
						name: "users_list",
						input: { query: { q: "SECRET-INPUT" } },
					},
					TOOLS_FINISH(),
				],
				toolCall("call-l2", "users_disable", { path: { id: alice.id } }),
				{ error: "auth" },
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "SECRET-PROMPT", attachments: [] });
			await socket.waitFor(turnDone());
			socket.send({ type: "permission.answer", id: "call-l2", optionId: "deny" });
			await socket.waitFor(turnDone("error"));
			const lines = logLines.join("\n");
			for (const secret of [
				"SECRET-REPLY",
				"SECRET-INPUT",
				"SECRET-PROMPT",
				"alice@example.edu",
				"sk-test-key",
			]) {
				expect(lines).not.toContain(secret);
			}
			socket.socket.close();
		}));
});

describe.skipIf(skip)("bulk work through run_batch", () => {
	const invite = (email: string) => ({
		body: { email, name: "Student", role: "student" },
	});

	test("one approval typed with the row count runs every row as its own call, and the model reads a per-row table", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			const emails = ["n1@example.edu", "n2@example.edu", "alice@example.edu"];
			const client = fake([
				toolCall("call-b1", "run_batch", {
					operation: "invitations.create",
					rows: emails.map(invite),
				}),
				reply("Invited."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "invite these", attachments: [] });
			const card = await socket.waitFor((f) => f.type === "permission.requested");
			await socket.waitFor(turnDone());
			expect(card).toMatchObject({
				id: "call-b1",
				toolName: "run_batch",
				title: expect.stringMatching(/^Invites someone/),
				input: { operation: "invitations.create", rows: emails.map(invite) },
				risk: "change",
				confirmText: "3",
			});
			expect(await auditOf("assistant.used")).toEqual([]);

			// A wrong count denies and runs nothing.
			socket.send({
				type: "permission.answer",
				id: "call-b1",
				optionId: "approve",
				confirmation: "2",
			});
			await turnsFinished(socket, 2);
			expect(outputOf(socket, "call-b1")).toBe(REFUSED_TEXT);
			expect(
				await testDb.db
					.selectFrom("account_invitations")
					.select("id")
					.where("email", "like", "n%@example.edu")
					.execute(),
			).toEqual([]);
			expect(client.requests).toHaveLength(2);
			socket.socket.close();
		}));

	test("an approved batch runs row by row; a refused row does not stop the rest", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			// The second row repeats the first address, so the route refuses it.
			const emails = ["n1@example.edu", "n1@example.edu", "n3@example.edu"];
			const client = fake([
				toolCall("call-b2", "run_batch", {
					operation: "invitations.create",
					rows: emails.map(invite),
				}),
				reply("Done."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "invite", attachments: [] });
			await socket.waitFor(turnDone());
			socket.send({
				type: "permission.answer",
				id: "call-b2",
				optionId: "approve",
				confirmation: "3",
			});
			await turnsFinished(socket, 2);

			const table = JSON.parse(outputOf(socket, "call-b2"));
			expect(table).toMatchObject({ operation: "invitations.create", rows: 3 });
			expect(table.results.map((r: { row: number }) => r.row)).toEqual([1, 2, 3]);
			expect(table.results[0]).toEqual({ row: 1, status: "ok", code: null });
			expect(table.results[1]).toMatchObject({ row: 2, status: "refused" });
			expect(table.results[1].code).toEqual(expect.any(String));
			expect(table.results[2]).toEqual({ row: 3, status: "ok", code: null });
			expect(table.ok).toBe(2);
			expect(
				(
					await testDb.db
						.selectFrom("account_invitations")
						.select("email")
						.where("email", "like", "n%@example.edu")
						.orderBy("email")
						.execute()
				).map((r) => r.email),
			).toEqual(["n1@example.edu", "n3@example.edu"]);
			// Each row wrote its own assistant.used row, without its inputs.
			const used = await auditOf("assistant.used");
			expect(used.map((r) => (r.metadata as { operation: string }).operation)).toEqual([
				"invitations.create",
				"invitations.create",
				"invitations.create",
			]);
			expect(JSON.stringify(used)).not.toContain("n1@example.edu");
			expect(lastToolResults(client.requests[1] as StepRequest)[0]).toMatchObject({
				isError: true,
				text: expect.stringContaining('"results"'),
			});
			const [row] = await testDb.db
				.selectFrom("assistant_approvals")
				.selectAll()
				.execute();
			expect(row).toMatchObject({
				operation: "run_batch",
				risk: "change",
				confirm_text: "3",
				status: "approved",
			});
			socket.socket.close();
		}));

	test("a bad row stops the whole call before any card is drawn; a read operation cannot be batched", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			fake([
				toolCall("call-b3", "run_batch", {
					operation: "invitations.create",
					rows: [invite("ok@example.edu"), invite("not-an-email")],
				}),
				toolCall("call-b4", "run_batch", {
					operation: "users.list",
					rows: [{ query: {} }],
				}),
				reply("Fixed."),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "invite", attachments: [] });
			await socket.waitFor(turnDone());
			expect(JSON.parse(outputOf(socket, "call-b3"))).toMatchObject({
				code: "VALIDATION_FAILED",
				message: expect.stringMatching(/Nothing ran\. One row is not valid: row 2:/),
			});
			expect(JSON.parse(outputOf(socket, "call-b4"))).toMatchObject({
				code: "VALIDATION_FAILED",
				message: expect.stringMatching(/only reads/),
			});
			expect(socket.frames.some((f) => f.type === "permission.requested")).toBe(false);
			expect(
				await testDb.db.selectFrom("assistant_approvals").selectAll().execute(),
			).toEqual([]);
			expect(await auditOf("assistant.used")).toEqual([]);
			socket.socket.close();
		}));

	test("a destructive batch also asks for the row count, and an instructor cannot batch an administrator operation", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol);
			fake([
				toolCall("call-b5", "run_batch", {
					operation: "egress.add_entry",
					rows: [
						{ body: { version: 0, kind: "host", value: "example.org", label: "" } },
					],
				}),
				reply("x"),
			]);
			const socket = await connect(app, carol, conv.id);
			socket.send({ type: "send", text: "allow it", attachments: [] });
			const card = await socket.waitFor((f) => f.type === "permission.requested");
			expect(card).toMatchObject({ risk: "destructive", confirmText: "1" });
			socket.socket.close();

			const ivy = await signIn(app, "ivy");
			const other = await newConversation(app, ivy);
			fake([
				toolCall("call-b6", "run_batch", {
					operation: "egress.add_entry",
					rows: [
						{ body: { version: 0, kind: "host", value: "example.org", label: "" } },
					],
				}),
				reply("x"),
			]);
			const second = await connect(app, ivy, other.id);
			second.send({ type: "send", text: "allow it", attachments: [] });
			await second.waitFor(turnDone());
			expect(JSON.parse(outputOf(second, "call-b6"))).toMatchObject({
				code: "NOT_FOUND",
			});
			expect(second.frames.some((f) => f.type === "permission.requested")).toBe(false);
			second.socket.close();
		}));
});

describe.skipIf(skip)("Diagnose", () => {
	/** A stopped workspace with no agent, so its agent reads answer with errors the model still sees. */
	async function makeWorkspace(): Promise<string> {
		const owner = await testDb.db
			.insertInto("users")
			.values({
				oidc_issuer: "http://mock",
				oidc_subject: `subject-${crypto.randomUUID()}`,
				display_name: "Student",
				email: null,
				role: "student",
				shutdown_grace_seconds: null,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const row = await testDb.db
			.insertInto("workspaces")
			.values({
				label: `ws-${crypto.randomUUID().slice(0, 8)}`,
				owner_user_id: owner.id,
				state: "stopped",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	function started(client: Client) {
		return client.frames.filter(
			(f): f is Extract<Frame, { type: "tool.started" }> => f.type === "tool.started",
		);
	}

	test("opening the socket runs the fixed reads as the person, then asks the model once", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol, { context: { kind: "health" } });
			const client = fake([reply("The disk is fine; nothing is wrong.")]);
			const socket = await connect(app, carol, conv.id);
			await turnsFinished(socket, 2);

			const calls = started(socket);
			expect(calls.map((c) => c.name)).toEqual([
				"health_get",
				"health_series",
				"logs_list",
			]);
			expect(calls[0]?.title).toMatch(/^Returns the site's current health/);
			expect(calls[1]?.input).toEqual({ query: { range: "1h" } });
			for (const one of calls) {
				expect(JSON.parse(outputOf(socket, one.id))).toBeTypeOf("object");
			}
			// Every call is closed; the log read may fail where there is no journal.
			const finished = socket.frames.filter((f) => f.type === "tool.finished");
			expect(finished.map((f) => f.id)).toEqual(calls.map((c) => c.id));
			expect(finished.slice(0, 2).map((f) => f.isError)).toEqual([false, false]);

			// One model call: the request, the reads as one step, then the fixed question.
			expect(client.requests).toHaveLength(1);
			const messages = client.requests[0]?.messages ?? [];
			expect(messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"tool",
				"user",
			]);
			expect(messages[0]).toMatchObject({ text: "Diagnose the site's health" });
			expect(messages[3]).toMatchObject({
				text: expect.stringMatching(
					/^What is the most likely cause for the site's health\?/,
				),
			});
			expect(
				lastToolResults({
					...(client.requests[0] as StepRequest),
					messages: messages.slice(0, 3),
				}).map((r) => r.name),
			).toEqual(["health_get", "health_series", "logs_list"]);
			expect(client.requests[0]?.system).toBe(
				systemPrompt({ role: "administrator", readOnly: true }),
			);
			const names = client.requests[0]?.tools.map((t) => t.name) ?? [];
			expect(names).not.toContain("run_batch");
			expect(names).not.toContain("users_disable");

			// Each read ran as the person and was audited; nothing asked for approval.
			const used = await auditOf("assistant.used");
			expect(
				used.map((r) => (r.metadata as { operation: string }).operation).sort(),
			).toEqual(["health.get", "health.series", "logs.list"]);
			expect(
				used.every((r) => r.via === "assistant" && r.actor === `user:${carol.id}`),
			).toBe(true);
			expect(socket.frames.some((f) => f.type === "permission.requested")).toBe(false);
			expect(
				await testDb.db.selectFrom("assistant_approvals").selectAll().execute(),
			).toEqual([]);

			const list = await call(app, carol, "GET", "/assistant/conversations");
			expect(list.json().conversations[0]).toMatchObject({
				title: "Diagnose the site's health",
				readOnly: true,
			});

			// A reconnect, or a second tab, repeats nothing.
			const before = (await storedTypes(conv.id)).length;
			socket.socket.close();
			const again = await connect(app, carol, conv.id);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(await storedTypes(conv.id)).toHaveLength(before);
			expect(client.requests).toHaveLength(1);
			expect(again.frames.some((f) => f.type === "turn.started")).toBe(true);
			again.socket.close();
		}));

	test("a workspace is read through its detail, agent log, processes and audit rows", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const workspace = await makeWorkspace();
			const conv = await newConversation(app, carol, {
				context: { kind: "workspace", id: workspace },
			});
			fake([reply("It is stopped.")]);
			const socket = await connect(app, carol, conv.id);
			await turnsFinished(socket, 2);
			const operations = (await auditOf("assistant.used")).map(
				(r) => (r.metadata as { operation: string }).operation,
			);
			expect(operations.sort()).toEqual([
				"audit.list",
				"workspaces.agent_log",
				"workspaces.get_detail",
				"workspaces.list_processes",
			]);
			const detail = started(socket).find((c) => c.title.startsWith("Returns"));
			expect(detail).toBeDefined();
			// The detail answers as the route does for the same workspace.
			const http = await call(app, carol, "GET", `/admin/workspaces/${workspace}`);
			const first = started(socket)[0];
			expect(JSON.parse(outputOf(socket, first?.id ?? ""))).toEqual(http.json());
			expect(socket.frames.some((f) => f.type === "permission.requested")).toBe(false);
			socket.socket.close();
		}));

	test("a job and an alert open too; an item that cannot be named, or a non-administrator, is refused", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const ivy = await signIn(app, "ivy");
			const id = crypto.randomUUID();
			for (const context of [
				{ kind: "job", id: "site:address" },
				{ kind: "job", id: `certificate:${id}` },
				{ kind: "alert", id },
			]) {
				const made = await newConversation(app, carol, { context });
				expect(made).toMatchObject({ readOnly: true, context });
			}
			for (const context of [
				{ kind: "workspace" },
				{ kind: "workspace", id: "x" },
				{ kind: "job", id: "site:nope" },
			]) {
				const res = await call(app, carol, "POST", "/assistant/conversations", {
					context,
				});
				expect(res.statusCode, JSON.stringify(context)).toBe(400);
			}
			const instructor = await call(app, ivy, "POST", "/assistant/conversations", {
				context: { kind: "health" },
			});
			expect(instructor.statusCode).toBe(403);
		}));

	test("a read that fails still reaches the model, as an error result", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol, {
				context: { kind: "workspace", id: crypto.randomUUID() },
			});
			const client = fake([reply("There is no such workspace.")]);
			const socket = await connect(app, carol, conv.id);
			await turnsFinished(socket, 2);
			const results = client.requests[0]?.messages.find((m) => m.role === "tool");
			expect(results?.role === "tool" && results.results.some((r) => r.isError)).toBe(
				true,
			);
			socket.socket.close();
		}));

	test("a session that has ended gets no reads", () =>
		withApp(async (app) => {
			const carol = await signIn(app, "carol");
			const conv = await newConversation(app, carol, { context: { kind: "health" } });
			fake([reply("x")]);
			await testDb.db.deleteFrom("sessions").execute();
			const upgrade = await upgradeStatus(
				app,
				`/assistant/conversations/${conv.id}/socket`,
				{ origin: ORIGIN, cookie: carol.jar.cookieHeader() },
			);
			expect(upgrade).not.toBe(101);
			expect(await storedTypes(conv.id)).toEqual([]);
		}));
});
