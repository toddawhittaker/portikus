import type { AddressInfo } from "node:net";
import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import {
	CloseCode,
	LANGUAGE_SERVER_MAX_FRAME_BYTES,
	MAX_LANGUAGE_SERVER_SOCKETS,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
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
 * The browser end of the language-server relay (SPEC.md §13.6, §24.1): the
 * owner alone opens it, the API carries frames without reading them, and
 * every close the browser hears uses words of the API's own.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "language-server-agent-token";
const ORIGIN = new URL(PUBLIC_URL).origin;
const MIB = 1024 * 1024;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;

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

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.languageServers.received.length = 0;
	agent.languageServers.closes.length = 0;
	agent.languageServers.routeMissing = false;
	agent.requests.length = 0;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	return async () => {
		await app.close();
	};
});

function path(server = "python", projectId = world.a.projectId): string {
	return `/workspaces/${world.a.workspaceId}/projects/${projectId}/language-servers/${server}`;
}

interface Socket {
	ws: WebSocket;
	frames: string[];
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
): Promise<Socket> {
	const { port } = app.server.address() as AddressInfo;
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
				frames,
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

function languageServerCalls(): string[] {
	return agent.requests
		.filter((one) => one.url.includes("/language-servers/"))
		.map((one) => one.url);
}

const INITIALIZE = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { processId: null },
});

test.skipIf(skip)(
	"frames reach the agent unread and its answers come back",
	async () => {
		const socket = await open(path("python"));
		socket.ws.send(INITIALIZE);
		const reply = JSON.parse(await socket.next());
		expect(reply.id).toBe(1);
		expect(reply.result.serverInfo.name).toBe("fake-python");
		// The agent heard the exact text, byte for byte.
		expect(agent.languageServers.received).toEqual([INITIALIZE]);

		// Text that is not JSON at all travels too: the API never parses a frame.
		const odd = "not json {{";
		socket.ws.send(odd);
		await expect.poll(() => agent.languageServers.received.length).toBe(2);
		expect(agent.languageServers.received[1]).toBe(odd);
		expect(socket.ws.readyState).toBe(WebSocket.OPEN);
		socket.ws.close();
	},
);

test.skipIf(skip)("each server id reaches its own agent path", async () => {
	for (const id of ["python", "typescript", "ruff"]) {
		const socket = await open(path(id));
		socket.ws.send(INITIALIZE);
		expect(JSON.parse(await socket.next()).result.serverInfo.name).toBe(`fake-${id}`);
		socket.ws.close();
	}
	expect(languageServerCalls().map((url) => url.split("/").pop())).toEqual([
		"python",
		"typescript",
		"ruff",
	]);
});

test.skipIf(skip)(
	"an agent frame up to 4 MiB passes and a larger one ends the pipe",
	async () => {
		const socket = await open(path("python"));
		socket.ws.send(INITIALIZE);
		await socket.next();

		// Past the 1 MiB that other pipes allow, so this pipe's own cap is in force.
		const big = "x".repeat(3 * MIB);
		expect(agent.languageServers.push(big)).toBe(1);
		expect((await socket.next()).length).toBe(big.length);

		expect(
			agent.languageServers.push("y".repeat(LANGUAGE_SERVER_MAX_FRAME_BYTES + 1)),
		).toBe(1);
		const closed = await socket.closed;
		expect(closed).toEqual({
			code: CloseCode.SERVER_ERROR,
			reason: "agent unavailable",
		});
	},
);

test.skipIf(skip)(
	"a browser frame over 1 MiB closes the socket with 1009",
	async () => {
		const socket = await open(path("python"));
		socket.ws.send("x".repeat(MIB + 1));
		expect((await socket.closed).code).toBe(1009);
	},
);

test.skipIf(skip)("a binary frame from the browser is refused", async () => {
	const socket = await open(path("python"));
	socket.ws.send(Buffer.from([1, 2, 3]));
	expect((await socket.closed).code).toBe(1003);
	expect(agent.languageServers.received).toEqual([]);
});

test.skipIf(skip)(
	"the fifth socket of a workspace is refused until one closes",
	async () => {
		const held: Socket[] = [];
		for (let i = 0; i < MAX_LANGUAGE_SERVER_SOCKETS; i += 1) {
			held.push(await open(path(i % 2 === 0 ? "python" : "typescript")));
		}
		const extra = await open(path("ruff"));
		expect(await extra.closed).toEqual({
			code: CloseCode.POLICY,
			reason: "too many connections",
		});

		const first = held.shift();
		first?.ws.close();
		await first?.closed;
		// The count is live, so the slot comes back once the pipe has wound down.
		await expect
			.poll(async () => {
				const again = await open(path("ruff"));
				again.ws.send(INITIALIZE);
				const outcome = await Promise.race([
					again.next().then(() => "open"),
					again.closed.then(() => "refused"),
				]);
				again.ws.close();
				return outcome;
			})
			.toBe("open");
		for (const socket of held) socket.ws.close();
	},
);

test.skipIf(skip)(
	"the agent's close codes reach the browser with fixed reasons",
	async () => {
		const secret = "SECRET-AGENT-WORDS";
		const cases: Array<[number, string]> = [
			[4412, "replaced by another window"],
			[4413, "idle"],
			[4414, "crashed"],
			[4415, "unavailable"],
			[4999, "agent closed"],
		];
		for (const [code, reason] of cases) {
			const socket = await open(path("python"));
			socket.ws.send(INITIALIZE);
			await socket.next();
			expect(agent.languageServers.closeAll(code, secret)).toBe(1);
			expect(await socket.closed).toEqual({ code, reason });
		}
	},
);

test.skipIf(skip)("the browser's close reason never reaches the agent", async () => {
	const socket = await open(path("python"));
	socket.ws.send(INITIALIZE);
	await socket.next();
	socket.ws.close(4000, "secret-browser-bytes");
	await expect.poll(() => agent.languageServers.closes.length).toBe(1);
	expect(agent.languageServers.closes[0]?.reason).toBe("browser closed");
});

test.skipIf(skip)(
	"an agent without the route is reported as unavailable (4415)",
	async () => {
		agent.languageServers.routeMissing = true;
		const socket = await open(path("typescript"));
		expect(await socket.closed).toEqual({
			code: CloseCode.LANGUAGE_SERVER_UNAVAILABLE,
			reason: "unavailable",
		});
	},
);

test.skipIf(skip)(
	"another agent failure is a plain agent-unavailable close",
	async () => {
		// The agent refuses the token, which is a failure and not a missing route.
		await testDb.db
			.updateTable("workspaces")
			.set({ agent_token: "wrong-token" })
			.where("id", "=", world.a.workspaceId)
			.execute();
		const socket = await open(path("python"));
		expect(await socket.closed).toEqual({
			code: CloseCode.SERVER_ERROR,
			reason: "agent unavailable",
		});
	},
);

test.skipIf(skip)(
	"with the site switch off the socket closes with 4416 and the agent is never called",
	async () => {
		await testDb.db
			.updateTable("settings")
			.set({ code_help_enabled: false })
			.where("id", "=", 1)
			.execute();
		const socket = await open(path("python"));
		socket.ws.send(INITIALIZE);
		expect(await socket.closed).toEqual({
			code: CloseCode.LANGUAGE_SERVER_DISABLED,
			reason: "code help is off",
		});
		expect(languageServerCalls()).toEqual([]);
		expect(agent.languageServers.received).toEqual([]);

		// Turned back on, the next socket opens.
		await testDb.db
			.updateTable("settings")
			.set({ code_help_enabled: true })
			.where("id", "=", 1)
			.execute();
		const again = await open(path("python"));
		again.ws.send(INITIALIZE);
		expect(JSON.parse(await again.next()).id).toBe(1);
		again.ws.close();
	},
);

test.skipIf(skip)("an unknown server id is refused before the upgrade", async () => {
	for (const id of ["pyright", "PYTHON", "python%2F..", "clangd"]) {
		await expect(open(path(id))).rejects.toMatchObject({ status: 400 });
	}
	expect(languageServerCalls()).toEqual([]);
});

test.skipIf(skip)(
	"a revoked session closes the socket within a second or two",
	async () => {
		const socket = await open(path("python"));
		socket.ws.send(INITIALIZE);
		await socket.next();
		await testDb.db.deleteFrom("sessions").execute();
		expect(await socket.closed).toEqual({
			code: CloseCode.SESSION_ENDED,
			reason: "session revoked",
		});
	},
);

/** The owner alone: nobody else gets a socket, however they are related to the workspace. */
test.skipIf(skip)("only the owner may open the socket", async () => {
	// A has shared the project and has live help open with the instructor.
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
		["another student", { origin: ORIGIN, cookie: world.b.jar.cookieHeader() }, 404],
		[
			"the instructor with a share and live help open",
			{ origin: ORIGIN, cookie: world.instructor.cookieHeader() },
			404,
		],
		["an administrator", { origin: ORIGIN, cookie: world.admin.cookieHeader() }, 404],
		["the owner with no Origin", { cookie: world.a.jar.cookieHeader() }, 403],
		[
			"the owner from another Origin",
			{ origin: "https://evil.example", cookie: world.a.jar.cookieHeader() },
			403,
		],
	];
	for (const [who, headers, status] of refusals) {
		await expect(open(path("python"), headers), who).rejects.toMatchObject({ status });
	}
	expect(languageServerCalls(), "a refused caller reached the agent").toEqual([]);

	// Another student's project id inside Alice's workspace is not found either.
	await expect(open(path("python", world.b.projectId))).rejects.toMatchObject({
		status: 404,
	});
	expect(languageServerCalls()).toEqual([]);
});
