import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { MAX_EVENT_SOCKETS_PER_WORKSPACE } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The project events pipe (SPEC.md §11.4, STACK.md §5): the control plane
 * forwards the agent's filesystem frames to the owner's browser, one agent
 * socket per browser socket, and nothing travels the other way.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const READY = { type: "fs", paths: [], git: true, truncated: true };

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let projectId: string;
const slug = "essay";

interface Frames {
	ws: WebSocket;
	next: () => Promise<string>;
	closed: Promise<{ code: number; reason: string }>;
	close: () => Promise<void>;
}

/** Open the events socket, or reject with the refused HTTP status. */
async function openEvents(id: string, pid: string, jar: CookieJar): Promise<Frames> {
	const address = app.server.address() as AddressInfo;
	const path = `/workspaces/${id}/projects/${pid}/events`;
	const headers: Record<string, string> = {
		origin: new URL(PUBLIC_URL).origin,
		cookie: jar.cookieHeader(),
	};
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
		headers,
	} as unknown as string[]);

	const all: string[] = [];
	const waiting: Array<(frame: string) => void> = [];
	let cursor = 0;
	ws.addEventListener("message", (event) => {
		const frame =
			typeof event.data === "string"
				? event.data
				: Buffer.from(event.data as ArrayBuffer).toString();
		all.push(frame);
		waiting.shift()?.(frame);
	});

	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener(
			"close",
			(event) => resolve({ code: event.code, reason: event.reason }),
			{ once: true },
		);
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

async function makeWorkspace(jar: CookieJar, running: boolean): Promise<string> {
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
			state: running ? "running" : "stopped",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function makeProject(id: string, name: string): Promise<string> {
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: id,
			slug: name,
			name,
			path: `/home/student/projects/${name}`,
			source: "new",
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return row.id;
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
	agent.projects.clear();
	agent.eventLimit = false;
	agent.watchFailures.clear();
	agent.eventCloses.length = 0;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeWorkspace(alice, true);
	projectId = await makeProject(workspaceId, slug);
	agent.projects.set(slug, { isGitRepo: true });
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("the ready frame comes first, then agent frames", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	// The watcher is live before anything else (SPEC.md §11.4).
	expect(JSON.parse(await socket.next())).toEqual(READY);

	const frame = { type: "fs", paths: ["README.md"], git: false, truncated: false };
	await expect.poll(() => agent.pushEvent("", slug, frame)).toBe(1);
	expect(JSON.parse(await socket.next())).toEqual(frame);

	await socket.close();
});

// SPEC.md 11.4: a change on disk, however it was made, reaches the browser.
test.skipIf(skip)("a file written on the agent sends an fs frame", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await socket.next())).toEqual(READY);

	const seeded = await fetch(`http://127.0.0.1:${agent.port}/__test/files`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${slug}/notes.md`, content: "# notes\n" }),
	});
	expect(seeded.status).toBe(204);

	expect(JSON.parse(await socket.next())).toEqual({
		type: "fs",
		paths: ["notes.md"],
		git: false,
		truncated: false,
	});

	await socket.close();
});

test.skipIf(skip)("a frame from the browser is not forwarded", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await socket.next())).toEqual(READY);

	const before = agent.eventsReceived;
	socket.ws.send(JSON.stringify({ type: "input", data: "rm -rf /" }));
	// Nothing comes back, and the socket stays open.
	const quiet = await Promise.race([
		socket.next(),
		new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 300)),
	]);
	expect(quiet).toBe("quiet");
	expect(socket.ws.readyState).toBe(WebSocket.OPEN);
	// The agent never saw the frame at all (SPEC.md §24.1).
	expect(agent.eventsReceived).toBe(before);

	await socket.close();
});

test.skipIf(skip)("an oversized agent frame closes the pipe", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await socket.next())).toEqual(READY);

	// Past the 1 MiB cap the control plane puts on the agent socket, so the
	// upstream socket fails and the browser is told the watcher failed.
	expect(agent.pushOversizedEvent("", slug)).toBe(1);
	const closed = await socket.closed;
	expect(closed.code).toBe(1011);
	expect(closed.reason).toBe("agent unavailable");
});

test.skipIf(skip)("the ninth events socket on a workspace is refused", async () => {
	const open: Frames[] = [];
	for (let i = 0; i < MAX_EVENT_SOCKETS_PER_WORKSPACE; i += 1) {
		const socket = await openEvents(workspaceId, projectId, alice);
		expect(JSON.parse(await socket.next())).toEqual(READY);
		open.push(socket);
	}

	const extra = await openEvents(workspaceId, projectId, alice);
	const closed = await extra.closed;
	expect(closed.code).toBe(1008);
	expect(closed.reason).toBe("too many watchers");

	for (const socket of open) await socket.close();

	// The cap is a live count, so a socket opens again once one is given back.
	const again = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await again.next())).toEqual(READY);
	await again.close();
});

test.skipIf(skip)(
	"a failed watcher reaches the browser as a fixed reason",
	async () => {
		agent.watchFailures.add(`/${slug}`);
		const socket = await openEvents(workspaceId, projectId, alice);
		// The agent's error frame comes through first, then the mapped close.
		expect(JSON.parse(await socket.next())).toEqual({
			type: "error",
			code: "WATCH_FAILED",
		});
		const closed = await socket.closed;
		expect(closed.code).toBe(1011);
		expect(closed.reason).toBe("watcher failed");
	},
);

test.skipIf(skip)("the browser's close reason never reaches the agent", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await socket.next())).toEqual(READY);

	const before = agent.eventCloses.length;
	socket.ws.close(4000, "secret-browser-bytes");
	await expect.poll(() => agent.eventCloses.length).toBeGreaterThan(before);
	const seen = agent.eventCloses[before];
	expect(seen?.reason).toBe("browser closed");
});

test.skipIf(skip)("another student cannot open the socket", async () => {
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	await expect(openEvents(workspaceId, projectId, bob)).rejects.toMatchObject({
		status: 404,
	});
});

test.skipIf(skip)("a stopped workspace is refused with 409", async () => {
	// A student has one workspace, so this is the same one, stopped.
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	await expect(openEvents(workspaceId, projectId, alice)).rejects.toMatchObject({
		status: 409,
	});
});

test.skipIf(skip)("a project that is not this workspace's is refused", async () => {
	await expect(
		openEvents(workspaceId, crypto.randomUUID(), alice),
	).rejects.toMatchObject({ status: 404 });
});

test.skipIf(skip)("the agent's close code reaches the browser", async () => {
	// The directory is gone, so the agent closes with 4404 (SPEC.md §11.4).
	agent.projects.delete(slug);
	const socket = await openEvents(workspaceId, projectId, alice);
	// The error frame comes first, then a reason the control plane owns.
	expect(JSON.parse(await socket.next())).toEqual({
		type: "error",
		code: "PROJECT_NOT_FOUND",
	});
	const closed = await socket.closed;
	expect(closed.code).toBe(4404);
	expect(closed.reason).toBe("project not found");
});

test.skipIf(skip)("the agent's socket cap reaches the browser", async () => {
	agent.eventLimit = true;
	const socket = await openEvents(workspaceId, projectId, alice);
	const closed = await socket.closed;
	expect(closed.code).toBe(1008);
	// The agent's own bytes never reach the browser (SPEC.md §24.1).
	expect(closed.reason).toBe("too many watchers");
});

test.skipIf(skip)("the agent socket closes when the browser does", async () => {
	const socket = await openEvents(workspaceId, projectId, alice);
	expect(JSON.parse(await socket.next())).toEqual(READY);
	expect(agent.pushEvent("", slug, READY)).toBe(1);

	await socket.close();
	await expect.poll(() => agent.pushEvent("", slug, READY)).toBe(0);
});

test.skipIf(skip)("a revoked session closes the socket with 4401", async () => {
	// Only intervals are faked, so the sockets and the database keep real IO.
	vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval"] });
	const fresh = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	const previous = app;
	try {
		await fresh.listen({ port: 0, host: "127.0.0.1" });
		app = fresh;

		const socket = await openEvents(workspaceId, projectId, alice);
		expect(JSON.parse(await socket.next())).toEqual(READY);

		await testDb.db.deleteFrom("sessions").execute();
		// Revocation takes effect within a second (SPEC.md §5.3).
		vi.advanceTimersByTime(1500);
		expect((await socket.closed).code).toBe(4401);
	} finally {
		// The shared server must come back even when an expectation fails,
		// or the teardown closes the wrong one.
		app = previous;
		await fresh.close();
		vi.useRealTimers();
	}
});

test.skipIf(skip)(
	"a new acceptable-use statement closes the socket at the next re-check",
	async () => {
		// Only intervals are faked, so the sockets and the database keep real IO.
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval"] });
		const fresh = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
		const previous = app;
		try {
			await fresh.listen({ port: 0, host: "127.0.0.1" });
			app = fresh;

			const socket = await openEvents(workspaceId, projectId, alice);
			expect(JSON.parse(await socket.next())).toEqual(READY);

			// A new version gates every open session (SPEC.md section 5.1).
			await testDb.db
				.insertInto("settings")
				.values({ id: 1, shutdown_grace_seconds: 900, acceptable_use_version: 2 })
				.execute();
			vi.advanceTimersByTime(1500);
			expect((await socket.closed).code).toBe(4401);
		} finally {
			app = previous;
			await fresh.close();
			vi.useRealTimers();
			await testDb.db.deleteFrom("settings").execute();
		}
	},
);
