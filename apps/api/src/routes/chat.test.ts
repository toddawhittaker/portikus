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
	MAX_TERMINAL_SOCKETS_PER_USER,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";

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
	presence.touched = 0;
	presence.dropped = 0;
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
/** Read an attach's opening frames: the snapshot, the replay, then the settings. */
async function drainScript(socket: Socket): Promise<void> {
	for (;;) {
		const event = JSON.parse(await socket.next()) as { type: string };
		if (event.type === "settings") return;
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
	"a terminal, another workspace's chat, or a missing id is a 404 before the upgrade",
	async () => {
		const bobChat = await createChat(app, world.b);
		for (const target of [
			path(world.a.terminalId),
			path(bobChat),
			path("00000000-0000-4000-8000-000000000000"),
		]) {
			await expect(open(target)).rejects.toMatchObject({ status: 404 });
		}
		expect(agent.requests.filter((one) => one.url.endsWith("/chat"))).toEqual([]);
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
	presence.touched = 0;
	presence.dropped = 0;
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

/** Test hooks on the presence helpers the chat socket calls; they pass through unless set. */
const presence = vi.hoisted(() => ({
	open: null as null | (() => Promise<void>),
	drop: null as null | (() => Promise<void>),
	touched: 0,
	dropped: 0,
}));

vi.mock("../workspaces/presence.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../workspaces/presence.js")>();
	return {
		...real,
		openPresence: (...args: Parameters<typeof real.openPresence>) =>
			presence.open ? presence.open() : real.openPresence(...args),
		dropPresence: (...args: Parameters<typeof real.dropPresence>) => {
			presence.dropped += 1;
			return presence.drop ? presence.drop() : real.dropPresence(...args);
		},
		touchPresence: (...args: Parameters<typeof real.touchPresence>) => {
			presence.touched += 1;
			return real.touchPresence(...args);
		},
	};
});

async function agentCloses(code: number, reason: string): Promise<void> {
	await fetch(`http://127.0.0.1:${agent.port}/__test/chats/${chatId}/close`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, reason }),
	});
}

test.skipIf(skip)("the browser hears fixed words when the agent closes", async () => {
	const cases: Array<[number, string]> = [
		[4404, "chat not found"],
		[1009, "frame too large"],
		[1000, "chat closed"],
	];
	for (const [code, expected] of cases) {
		const socket = await open(path());
		await socket.next();
		await agentCloses(code, "agent-secret-words");
		expect(await socket.closed).toEqual({ code, reason: expected });
	}
});

test.skipIf(skip)(
	"a user at the terminal socket cap is refused with 4429",
	async () => {
		for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i += 1) {
			terminalSockets.take(world.a.userId);
		}
		try {
			const socket = await open(path());
			expect((await socket.closed).code).toBe(4429);
		} finally {
			for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i += 1) {
				terminalSockets.release(world.a.userId);
			}
		}
	},
);

test.skipIf(skip)(
	"a presence write that fails closes the socket and frees its slots",
	async () => {
		presence.open = () => Promise.reject(new Error("database down"));
		const socket = await open(path());
		await socket.closed;
		expect(terminalSockets.open(world.a.userId)).toBe(0);
		presence.open = null;
		const again = await open(path());
		expect(JSON.parse(await again.next()).type).toBe("snapshot");
		again.ws.close();
	},
);

test.skipIf(skip)(
	"a browser that leaves during the presence write is cleaned up",
	async () => {
		presence.open = async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		};
		const socket = await open(path());
		socket.ws.terminate();
		await socket.closed;
		await expect.poll(() => presence.dropped).toBe(1);
		expect(terminalSockets.open(world.a.userId)).toBe(0);
		presence.open = null;
	},
);

test.skipIf(skip)(
	"a failed presence delete is logged without frame content",
	async () => {
		const { logger, lines } = collectingLogger();
		const logged = buildTestServer(
			testDb.db,
			mock.issuer,
			{ AGENT_PORT: agent.port },
			logger,
		);
		await logged.listen({ port: 0, host: "127.0.0.1" });
		try {
			presence.drop = () => Promise.reject(new Error("database down"));
			const socket = await open(
				path(),
				{ origin: ORIGIN, cookie: world.a.jar.cookieHeader() },
				logged,
			);
			await socket.next();
			socket.ws.close();
			await socket.closed;
			await expect
				.poll(() => JSON.stringify(lines))
				.toContain("failed to delete workspace connection");
		} finally {
			presence.drop = null;
			await logged.close();
		}
	},
);

test.skipIf(skip)("a workspace with no agent address closes 1011", async () => {
	await testDb.db
		.updateTable("workspaces")
		.set({ agent_address: null })
		.where("id", "=", world.a.workspaceId)
		.execute();
	const socket = await open(path());
	expect(await socket.closed).toEqual({ code: 1011, reason: "agent unavailable" });
});

test.skipIf(skip)("an open chat refreshes its presence every 15 seconds", async () => {
	vi.useFakeTimers({ toFake: ["setInterval"] });
	try {
		const socket = await open(path());
		await socket.next();
		vi.advanceTimersByTime(15_000);
		expect(presence.touched).toBeGreaterThan(0);
		socket.ws.close();
		await socket.closed;
	} finally {
		vi.useRealTimers();
	}
});
