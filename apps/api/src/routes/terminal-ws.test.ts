import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The terminal transport (SPEC.md §9.7, ADR 0009): the API forwards frames
 * between the browser and the workspace agent without reading them, and an
 * attached terminal counts as browser presence (SPEC.md §6.4).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let terminalId: string;

interface Frames {
	ws: WebSocket;
	text: string[];
	binary: string[];
	next: () => Promise<string>;
	closed: Promise<number>;
	close: () => Promise<void>;
}

/** Open the terminal socket, or reject with the refused status code. */
async function openTerminal(
	id: string,
	tid: string,
	jar: CookieJar,
	overrides: Record<string, string> = {},
): Promise<Frames> {
	const address = app.server.address() as AddressInfo;
	const path = `/workspaces/${id}/terminals/${tid}/ws?cols=100&rows=30`;
	const headers: Record<string, string> = {
		origin: new URL(PUBLIC_URL).origin,
		cookie: jar.cookieHeader(),
		...overrides,
	};
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
		headers,
	} as unknown as string[]);
	ws.binaryType = "arraybuffer";

	const text: string[] = [];
	const binary: string[] = [];
	const all: string[] = [];
	const waiting: Array<(frame: string) => void> = [];
	let cursor = 0;

	ws.addEventListener("message", (event) => {
		let frame: string;
		if (typeof event.data === "string") {
			frame = event.data;
			text.push(frame);
		} else {
			frame = Buffer.from(event.data as ArrayBuffer).toString();
			binary.push(frame);
		}
		all.push(frame);
		waiting.shift()?.(frame);
	});

	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener(
			"error",
			() => {
				// The WebSocket API hides the HTTP status, so ask the app directly.
				app
					.inject({
						method: "GET",
						url: path,
						headers: {
							...headers,
							upgrade: "websocket",
							connection: "upgrade",
							"sec-websocket-version": "13",
							"sec-websocket-key": crypto.randomBytes(16).toString("base64"),
						},
					})
					.then((res) => reject({ status: res.statusCode }))
					.catch(() => reject({ status: 0 }));
			},
			{ once: true },
		);
	});

	return {
		ws,
		text,
		binary,
		closed,
		next: () =>
			new Promise<string>((resolve) => {
				const pending = all[cursor];
				if (pending !== undefined) {
					cursor += 1;
					resolve(pending);
					return;
				}
				waiting.push((frame) => {
					cursor += 1;
					resolve(frame);
				});
			}),
		close: () =>
			new Promise<void>((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.close();
			}),
	};
}

async function countConnections(): Promise<number> {
	const rows = await testDb.db
		.selectFrom("workspace_connections")
		.selectAll()
		.execute();
	return rows.length;
}

async function makeRunningWorkspace(jar: CookieJar): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
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
	agent.terminals.clear();
	agent.received.length = 0;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeRunningWorkspace(alice);
	terminalId = (
		await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/terminals`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: {},
		})
	).json().id;
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("frames are forwarded in both directions unchanged", async () => {
	const socket = await openTerminal(workspaceId, terminalId, alice);

	// The agent's greeting proves the query string reached it as a text frame.
	const greeting = JSON.parse(await socket.next());
	expect(greeting).toEqual({ type: "size", cols: "100", rows: "30" });

	const input = JSON.stringify({ type: "input", data: "ls -la\r" });
	socket.ws.send(input);
	expect(await socket.next()).toBe(`echo:${input}`);
	expect(agent.received).toContain(input);
	expect(socket.binary).toContain(`echo:${input}`);

	socket.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
	const resized = JSON.parse(await socket.next());
	expect(resized).toEqual({ type: "size", cols: 120 });

	await socket.close();
});

test.skipIf(skip)(
	"an attached terminal is present and its row goes on close",
	async () => {
		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();
		expect(await countConnections()).toBe(1);

		const workspace = await testDb.db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(workspace.desired_state).toBe("running");

		await socket.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await countConnections()).toBe(0);
	},
);

test.skipIf(skip)("the agent socket closes when the browser does", async () => {
	const socket = await openTerminal(workspaceId, terminalId, alice);
	await socket.next();
	expect(agent.openAttachments).toBe(1);

	await socket.close();
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(agent.openAttachments).toBe(0);
});

test.skipIf(skip)("another student cannot attach", async () => {
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	await expect(openTerminal(workspaceId, terminalId, bob)).rejects.toMatchObject({
		status: 404,
	});
	expect(await countConnections()).toBe(0);
});

test.skipIf(skip)("an unauthenticated or cross-origin upgrade is refused", async () => {
	await expect(
		openTerminal(workspaceId, terminalId, new CookieJar()),
	).rejects.toMatchObject({ status: 401 });
	await expect(
		openTerminal(workspaceId, terminalId, alice, {
			origin: "https://evil.example.com",
		}),
	).rejects.toMatchObject({ status: 403 });
});

test.skipIf(skip)("attaching to an ended terminal is refused", async () => {
	await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	await expect(openTerminal(workspaceId, terminalId, alice)).rejects.toMatchObject({
		status: 404,
	});
});

test.skipIf(skip)(
	"the browser socket closes with 1011 when the agent is down",
	async () => {
		await testDb.db
			.updateTable("workspaces")
			.set({ agent_address: "127.0.0.127", updated_at: new Date().toISOString() })
			.where("id", "=", workspaceId)
			.execute();

		const socket = await openTerminal(workspaceId, terminalId, alice);
		expect(await socket.closed).toBe(1011);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await countConnections()).toBe(0);
	},
);

test.skipIf(skip)("a revoked session closes the attachment with 4401", async () => {
	// Only intervals are faked, so the sockets and the database keep real IO.
	vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval"] });
	try {
		const fresh = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
		await fresh.listen({ port: 0, host: "127.0.0.1" });
		const previous = app;
		app = fresh;

		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();

		await testDb.db.deleteFrom("sessions").execute();
		vi.advanceTimersByTime(31_000);

		expect(await socket.closed).toBe(4401);
		await fresh.close();
		app = previous;
	} finally {
		vi.useRealTimers();
	}
});
