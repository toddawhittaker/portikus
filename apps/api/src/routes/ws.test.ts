import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	type OpenSocket,
	openWorkspaceSocket,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;

/** Resolve with the close code the server used. */
function nextClose(socket: OpenSocket): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no close")), 5000);
		socket.ws.addEventListener(
			"close",
			(event) => {
				clearTimeout(timer);
				resolve(event.code);
			},
			{ once: true },
		);
	});
}

async function countConnections(): Promise<number> {
	const rows = await testDb.db
		.selectFrom("workspace_connections")
		.selectAll()
		.execute();
	return rows.length;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)(
	"the owner receives a workspace message and is counted present",
	async () => {
		const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		const message = (await socket.next()) as Record<string, unknown>;

		expect(message.type).toBe("workspace");
		expect((message.workspace as { id: string }).id).toBe(workspaceId);
		expect(await countConnections()).toBe(1);

		const row = await testDb.db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(row.desired_state).toBe("running");
		expect(row.last_active_connection_at).not.toBeNull();

		await socket.close();
	},
);

test.skipIf(skip)("a heartbeat refreshes last_seen_at", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	const before = await testDb.db
		.selectFrom("workspace_connections")
		.selectAll()
		.executeTakeFirstOrThrow();

	await new Promise((resolve) => setTimeout(resolve, 50));
	socket.ws.send(JSON.stringify({ type: "heartbeat" }));
	await new Promise((resolve) => setTimeout(resolve, 300));

	const after = await testDb.db
		.selectFrom("workspace_connections")
		.selectAll()
		.executeTakeFirstOrThrow();
	expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(
		new Date(before.last_seen_at).getTime(),
	);

	await socket.close();
});

test.skipIf(skip)("a malformed frame is ignored", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	socket.ws.send("not json at all");
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(socket.ws.readyState).toBe(WebSocket.OPEN);

	await socket.close();
});

test.skipIf(skip)("a revoked session closes the socket with 4401", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	await testDb.db.deleteFrom("sessions").execute();
	const closed = nextClose(socket);
	socket.ws.send(JSON.stringify({ type: "heartbeat" }));

	expect(await closed).toBe(4401);
});

test.skipIf(skip)("closing the socket removes the connection row", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();
	expect(await countConnections()).toBe(1);

	await socket.close();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(await countConnections()).toBe(0);
});

test.skipIf(skip)("another student cannot open the socket", async () => {
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);

	await expect(
		openWorkspaceSocket(app, workspaceId, bob, PUBLIC_URL),
	).rejects.toMatchObject({ status: 404 });
	expect(await countConnections()).toBe(0);
});

test.skipIf(skip)("an unauthenticated upgrade is refused", async () => {
	await expect(
		openWorkspaceSocket(app, workspaceId, new CookieJar(), PUBLIC_URL),
	).rejects.toMatchObject({ status: 401 });
	expect(await countConnections()).toBe(0);
});

test.skipIf(skip)("an upgrade from another origin is refused", async () => {
	await expect(
		openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL, {
			origin: "https://evil.example.com",
		}),
	).rejects.toMatchObject({ status: 403 });
	expect(await countConnections()).toBe(0);
});

test.skipIf(skip)("a state change is broadcast to open sockets", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	const update = socket.next() as Promise<Record<string, unknown>>;
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();

	const message = await update;
	expect((message.workspace as { state: string }).state).toBe("running");

	await socket.close();
});

test.skipIf(skip)("shutting the server down closes sockets with 1001", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	const closed = nextClose(socket);
	await app.close();
	expect(await closed).toBe(1001);
});
