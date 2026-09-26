import * as crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
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
import WebSocketClient from "ws";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { terminalGoneReason } from "./terminals.js";

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
		// Revocation takes effect within a second (SPEC.md section 5.3).
		vi.advanceTimersByTime(1500);

		expect(await socket.closed).toBe(4401);
		await fresh.close();
		app = previous;
	} finally {
		vi.useRealTimers();
	}
});

test.skipIf(skip)("a revoked session is caught on the next input frame", async () => {
	// The interval is faked and never advanced, so only the per-frame check
	// can close this socket (SPEC.md section 5.3).
	vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval"] });
	try {
		const fresh = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
		await fresh.listen({ port: 0, host: "127.0.0.1" });
		const previous = app;
		app = fresh;

		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();

		await testDb.db.deleteFrom("sessions").execute();
		// The check runs at most once a second, so let that second pass.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		socket.ws.send(JSON.stringify({ type: "input", data: "x" }));

		expect(await socket.closed).toBe(4401);
		await fresh.close();
		app = previous;
	} finally {
		vi.useRealTimers();
	}
});

test.skipIf(skip)(
	"an administrator cannot attach to a student's terminal",
	async () => {
		const carol = new CookieJar();
		await loginAs(app, "carol", carol);
		await expect(openTerminal(workspaceId, terminalId, carol)).rejects.toMatchObject({
			status: 404,
		});
		expect(await countConnections()).toBe(0);
	},
);

test.skipIf(skip)(
	"a browser that closes during the upgrade leaves nothing behind",
	async () => {
		const address = app.server.address() as AddressInfo;
		const path = `/workspaces/${workspaceId}/terminals/${terminalId}/ws`;

		// Close the moment the upgrade completes, which lands inside the
		// handler's presence writes.
		for (let i = 0; i < 5; i += 1) {
			await new Promise<void>((resolve) => {
				const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
					headers: {
						origin: new URL(PUBLIC_URL).origin,
						cookie: alice.cookieHeader(),
					},
				} as unknown as string[]);
				ws.addEventListener("open", () => ws.close(), { once: true });
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.addEventListener("error", () => resolve(), { once: true });
			});
		}

		await expect.poll(async () => await countConnections(), { timeout: 5000 }).toBe(0);
		await expect.poll(() => agent.openAttachments, { timeout: 5000 }).toBe(0);

		// Shutdown must not hang on work the dropped sockets left running.
		await app.close();
		app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
		await app.listen({ port: 0, host: "127.0.0.1" });
	},
);

test.skipIf(skip)(
	"too much input before the agent answers is refused",
	async () => {
		// An agent that takes a moment to accept the upgrade, so the browser can
		// type while the control plane is still dialling it.
		const slow = createHttpServer();
		const upgrades: Array<() => void> = [];
		slow.on("upgrade", (_request, socket) => {
			upgrades.push(() => socket.destroy());
		});
		await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
		const slowPort = (slow.address() as AddressInfo).port;

		const fresh = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: slowPort });
		await fresh.listen({ port: 0, host: "127.0.0.1" });
		const port = (fresh.server.address() as AddressInfo).port;
		// The ws client reports the close code even while it is writing.
		const client = new WebSocketClient(
			`ws://127.0.0.1:${port}/workspaces/${workspaceId}/terminals/${terminalId}/ws`,
			{
				headers: {
					origin: new URL(PUBLIC_URL).origin,
					cookie: alice.cookieHeader(),
				},
			},
		);
		try {
			const closed = new Promise<number>((resolve) => {
				client.on("close", (code: number) => resolve(code));
			});
			await new Promise<void>((resolve, reject) => {
				client.on("open", () => resolve());
				client.on("error", reject);
			});

			const chunk = JSON.stringify({ type: "input", data: "x".repeat(8 * 1024) });
			for (let i = 0; i < 12 && client.readyState === WebSocketClient.OPEN; i += 1) {
				client.send(chunk);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			expect(await closed).toBe(1009);
			// The close frame can reach the browser before the server has
			// finished clearing its presence row, so wait for that to land.
			await expect
				.poll(async () => await countConnections(), { timeout: 5000 })
				.toBe(0);
		} finally {
			client.terminate();
			for (const finish of upgrades) finish();
			await fresh.close();
			await new Promise<void>((resolve) => {
				slow.close(() => resolve());
			});
		}
	},
	20_000,
);

/** Stage a terminals unit stop in the fake agent, or clear it with null. */
async function stageTerminalsExit(
	result: string | null,
	options: { at?: string; terminalId?: string } = {},
): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/terminals-exit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ result, ...options }),
	});
	expect(response.ok).toBe(true);
}

test("a stop after the terminal was made explains it; an older one does not", () => {
	const created = new Date("2026-09-26T10:00:00Z");
	const after = "2026-09-26T10:05:00.000Z";
	expect(terminalGoneReason({ result: "oom-kill", at: after }, created)).toBe(
		"out_of_memory",
	);
	expect(terminalGoneReason({ result: "signal", at: after }, created)).toBe(
		"restarted",
	);
	expect(terminalGoneReason({ result: "success", at: after }, created)).toBe(
		"restarted",
	);
	expect(
		terminalGoneReason({ result: "oom-kill", at: "2026-09-26T09:00:00.000Z" }, created),
	).toBeNull();
	expect(terminalGoneReason({ result: "oom-kill", at: "garbage" }, created)).toBeNull();
	expect(terminalGoneReason(null, created)).toBeNull();
});

test.skipIf(skip)(
	"a terminal lost to an out-of-memory restart is explained to the browser",
	async () => {
		await stageTerminalsExit("oom-kill", { terminalId });
		try {
			const socket = await openTerminal(workspaceId, terminalId, alice);
			const frame = JSON.parse(await socket.next());
			expect(frame).toMatchObject({
				type: "error",
				code: "TERMINAL_NOT_FOUND",
				reason: "out_of_memory",
			});
			expect(typeof frame.at).toBe("string");
			expect(await socket.closed).toBe(1008);
		} finally {
			await stageTerminalsExit(null);
		}
	},
);

test.skipIf(skip)(
	"a restart older than the terminal gives the plain frame",
	async () => {
		await stageTerminalsExit("oom-kill", {
			terminalId,
			at: "2000-01-01T00:00:00.000Z",
		});
		try {
			const socket = await openTerminal(workspaceId, terminalId, alice);
			expect(JSON.parse(await socket.next())).toEqual({
				type: "error",
				code: "TERMINAL_NOT_FOUND",
			});
			expect(await socket.closed).toBe(1008);
		} finally {
			await stageTerminalsExit(null);
		}
	},
);

async function agentPost(path: string, body: unknown): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.ok).toBe(true);
}

test.skipIf(skip)(
	"a flood of session-gone frames from the agent costs one record lookup",
	async () => {
		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();
		const before = agent.lastExitHits;
		const gone = JSON.stringify({ type: "error", code: "TERMINAL_NOT_FOUND" });
		await agentPost(`/__test/terminals/${terminalId}/frames`, {
			frames: Array.from({ length: 50 }, () => gone),
		});
		expect(JSON.parse(await socket.next())).toEqual({
			type: "error",
			code: "TERMINAL_NOT_FOUND",
		});
		await socket.closed;
		expect(agent.lastExitHits - before).toBe(1);
		expect(
			socket.text.filter((frame) => frame.includes("TERMINAL_NOT_FOUND")),
		).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"an exit followed shortly by an out-of-memory record is explained",
	async () => {
		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();
		try {
			await agentPost("/__test/terminals-exit", {
				result: "oom-kill",
				terminalIds: [terminalId],
				live: true,
				recordDelayMs: 600,
			});
			expect(JSON.parse(await socket.next())).toMatchObject({
				type: "error",
				code: "TERMINAL_NOT_FOUND",
				reason: "out_of_memory",
			});
		} finally {
			await socket.close();
			await stageTerminalsExit(null);
		}
	},
);

test.skipIf(skip)("an ordinary exit closes at once with no record lookup", async () => {
	const socket = await openTerminal(workspaceId, terminalId, alice);
	await socket.next();
	const before = agent.lastExitHits;
	const started = Date.now();
	socket.ws.send(JSON.stringify({ type: "input", data: "\u0004" }));
	let frame = await socket.next();
	while (frame.startsWith("echo:")) frame = await socket.next();
	expect(JSON.parse(frame)).toEqual({ type: "exit" });
	expect(Date.now() - started).toBeLessThan(500);
	expect(agent.lastExitHits).toBe(before);
	await socket.close();
});

test.skipIf(skip)(
	"an exit from an older agent, with no serverGone, is ordinary",
	async () => {
		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();
		const before = agent.lastExitHits;
		const started = Date.now();
		await agentPost(`/__test/terminals/${terminalId}/frames`, {
			frames: [JSON.stringify({ type: "exit" })],
		});
		expect(JSON.parse(await socket.next())).toEqual({ type: "exit" });
		expect(Date.now() - started).toBeLessThan(500);
		expect(agent.lastExitHits).toBe(before);
		await socket.close();
	},
);

test.skipIf(skip)(
	"a server-gone exit with no newer record stays a plain exit",
	async () => {
		const socket = await openTerminal(workspaceId, terminalId, alice);
		await socket.next();
		const before = agent.lastExitHits;
		await agentPost(`/__test/terminals/${terminalId}/frames`, {
			frames: [JSON.stringify({ type: "exit", serverGone: true })],
		});
		expect(JSON.parse(await socket.next())).toEqual({ type: "exit" });
		expect(agent.lastExitHits - before).toBeGreaterThan(1);
		await socket.close();
	},
);
