import type { AddressInfo } from "node:net";
import {
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	CreateTerminalRequest,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The browser end of the chat relay (SPEC.md §9.7, §24.1): the owner alone
 * opens it, only on a chat tab, frames are capped in both directions, and
 * nothing in a frame is logged.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "chat-agent-token";
const ORIGIN = new URL(PUBLIC_URL).origin;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;
let chatId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

async function createChat(
	server: FastifyInstance,
	student: MatrixWorld["a"],
): Promise<string> {
	const created = await server.inject({
		method: "POST",
		url: `/workspaces/${student.workspaceId}/terminals`,
		headers: csrfHeaders(student.jar, PUBLIC_URL),
		payload: { kind: "chat", agent: "claude", projectId: student.projectId },
	});
	expect(created.statusCode).toBe(201);
	return created.json().id as string;
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.requests.length = 0;
	agent.creates.length = 0;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	chatId = await createChat(app, world.a);
	return async () => {
		await app.close();
	};
});

function path(terminalId = chatId, workspaceId = world.a.workspaceId): string {
	return `/workspaces/${workspaceId}/terminals/${terminalId}/chat`;
}

interface Socket {
	ws: WebSocket;
	next: () => Promise<string>;
	closed: Promise<{ code: number; reason: string }>;
}

/** Open the socket as Alice, or reject with the HTTP status that refused it. */
function open(
	target: string,
	headers: Record<string, string> = {
		origin: ORIGIN,
		cookie: world.a.jar.cookieHeader(),
	},
	server: FastifyInstance = app,
): Promise<Socket> {
	const { port } = server.server.address() as AddressInfo;
	const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, { headers });
	const frames: string[] = [];
	const waiting: Array<(frame: string) => void> = [];
	ws.on("message", (data) => {
		const frame = data.toString();
		const waiter = waiting.shift();
		if (waiter) waiter(frame);
		else frames.push(frame);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
	});
	return new Promise((resolve, reject) => {
		ws.once("open", () =>
			resolve({
				ws,
				closed,
				next: () =>
					new Promise<string>((done) => {
						const ready = frames.shift();
						if (ready !== undefined) done(ready);
						else waiting.push(done);
					}),
			}),
		);
		ws.once("unexpected-response", (_request, response) => {
			reject({ status: response.statusCode });
			ws.terminate();
		});
		ws.once("error", () => {});
	});
}

/** Read the snapshot and the scripted turn the fake sends on first attach. */
async function drainScript(socket: Socket): Promise<void> {
	for (;;) {
		const event = JSON.parse(await socket.next()) as { type: string };
		if (event.type === "turn.finished") return;
	}
}

async function fakeReceived(id = chatId): Promise<string[]> {
	const reply = await fetch(
		`http://127.0.0.1:${agent.port}/__test/chats/${id}/received`,
	);
	return ((await reply.json()) as { received: string[] }).received;
}

async function fakeSendRaw(bytes: number): Promise<void> {
	await fetch(`http://127.0.0.1:${agent.port}/__test/chats/${chatId}/raw`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ bytes }),
	});
}

test.skipIf(skip)(
	"the owner gets a snapshot and frames reach the agent unchanged",
	async () => {
		const socket = await open(path());
		expect(JSON.parse(await socket.next()).type).toBe("snapshot");
		// Odd spacing proves the relay never re-serializes.
		const frame = '{ "type" :  "interrupt" }';
		socket.ws.send(frame);
		await expect.poll(() => fakeReceived()).toEqual([frame]);
		socket.ws.close();
	},
);

test.skipIf(skip)("only the owner may open the socket", async () => {
	await testDb.db
		.insertInto("project_shares")
		.values({
			project_id: world.a.projectId,
			ends_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		.execute();
	const helper = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", "ivy")
		.executeTakeFirstOrThrow();
	await testDb.db
		.insertInto("live_help_sessions")
		.values({
			workspace_id: world.a.workspaceId,
			project_id: world.a.projectId,
			helper_user_id: helper.id,
			course_id: world.courseId,
			ends_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		.execute();

	const refusals: Array<[string, Record<string, string>, number]> = [
		["anonymous", { origin: ORIGIN }, 401],
		[
			"another student (a share viewer)",
			{ origin: ORIGIN, cookie: world.b.jar.cookieHeader() },
			404,
		],
		[
			"the instructor and live-help helper",
			{ origin: ORIGIN, cookie: world.instructor.cookieHeader() },
			404,
		],
		["an administrator", { origin: ORIGIN, cookie: world.admin.cookieHeader() }, 404],
	];
	for (const [who, headers, status] of refusals) {
		await expect(open(path(), headers), who).rejects.toMatchObject({ status });
	}
	expect(agent.requests.filter((one) => one.url.endsWith("/chat"))).toEqual([]);
});

test.skipIf(skip)(
	"a terminal, another workspace's chat, or a missing id closes 4404",
	async () => {
		const bobChat = await createChat(app, world.b);
		for (const target of [
			path(world.a.terminalId),
			path(bobChat),
			path("00000000-0000-4000-8000-000000000000"),
		]) {
			const socket = await open(target);
			expect((await socket.closed).code).toBe(4404);
		}
	},
);

test.skipIf(skip)("a fifth attachment to one chat is refused", async () => {
	const held: Socket[] = [];
	for (let i = 0; i < MAX_ATTACHMENTS_PER_TERMINAL; i += 1)
		held.push(await open(path()));
	const extra = await open(path());
	expect((await extra.closed).code).toBe(4429);
	for (const one of held) one.ws.close();
});

test.skipIf(skip)(
	"a browser frame is accepted at the cap and refused one byte over",
	async () => {
		const atCap = await open(path());
		await atCap.next();
		atCap.ws.send("a".repeat(MAX_CHAT_CLIENT_FRAME_BYTES));
		await expect.poll(async () => (await fakeReceived()).length).toBe(1);
		atCap.ws.close();

		const over = await open(path());
		over.ws.send("a".repeat(MAX_CHAT_CLIENT_FRAME_BYTES + 1));
		expect((await over.closed).code).toBe(1009);
	},
);

test.skipIf(skip)(
	"an agent frame is relayed at the cap and closes 1009 one byte over",
	async () => {
		const atCap = await open(path());
		await drainScript(atCap);
		await fakeSendRaw(MAX_CHAT_SERVER_FRAME_BYTES);
		expect((await atCap.next()).length).toBe(MAX_CHAT_SERVER_FRAME_BYTES);
		await fakeSendRaw(MAX_CHAT_SERVER_FRAME_BYTES + 1);
		expect((await atCap.closed).code).toBe(1009);
	},
);

test.skipIf(skip)("a binary frame from the browser is refused", async () => {
	const socket = await open(path());
	await socket.next();
	socket.ws.send(Buffer.from([1, 2, 3]));
	expect((await socket.closed).code).toBe(1003);
	expect(await fakeReceived()).toEqual([]);
});

test.skipIf(skip)("frame content never reaches the logs", async () => {
	const marker = "PRIVATE-PROMPT-MARKER";
	const { logger, lines } = collectingLogger();
	const logged = buildTestServer(
		testDb.db,
		mock.issuer,
		{ AGENT_PORT: agent.port },
		logger,
	);
	await logged.listen({ port: 0, host: "127.0.0.1" });
	try {
		const socket = await open(
			path(),
			{ origin: ORIGIN, cookie: world.a.jar.cookieHeader() },
			logged,
		);
		await drainScript(socket);
		socket.ws.send(JSON.stringify({ type: "send", text: marker, attachments: [] }));
		// The fake echoes the prompt back, so the marker has crossed both ways.
		for (;;) {
			const frame = await socket.next();
			if (frame.includes(marker)) break;
		}
		socket.ws.close();
		await socket.closed;
	} finally {
		await logged.close();
	}
	expect(JSON.stringify(lines)).not.toContain(marker);
});

test.skipIf(skip)(
	"creating a chat stores its kind, forwards it, and lists it",
	async () => {
		expect(agent.creates.at(-1)).toMatchObject({
			id: chatId,
			kind: "chat",
			agent: "claude",
		});
		const row = await testDb.db
			.selectFrom("terminals")
			.select("kind")
			.where("id", "=", chatId)
			.executeTakeFirstOrThrow();
		expect(row.kind).toBe("chat");

		const listed = await app.inject({
			method: "GET",
			url: `/workspaces/${world.a.workspaceId}/terminals`,
			headers: { cookie: world.a.jar.cookieHeader() },
		});
		const kinds = Object.fromEntries(
			(listed.json().terminals as Array<{ id: string; kind: string }>).map((one) => [
				one.id,
				one.kind,
			]),
		);
		expect(kinds[chatId]).toBe("chat");
		expect(kinds[world.a.terminalId]).toBe("terminal");
	},
);

test.skipIf(skip)("a plain terminal create forwards no kind", async () => {
	agent.creates.length = 0;
	const created = await app.inject({
		method: "POST",
		url: `/workspaces/${world.a.workspaceId}/terminals`,
		headers: csrfHeaders(world.a.jar, PUBLIC_URL),
		payload: {},
	});
	expect(created.statusCode).toBe(201);
	expect(agent.creates[0]).not.toHaveProperty("kind");
});

test("the create request refuses a codex chat and a chat with no agent", () => {
	expect(
		CreateTerminalRequest.safeParse({ kind: "chat", agent: "codex" }).success,
	).toBe(false);
	expect(CreateTerminalRequest.safeParse({ kind: "chat" }).success).toBe(false);
	expect(
		CreateTerminalRequest.safeParse({ kind: "chat", agent: "claude" }).success,
	).toBe(true);
});
