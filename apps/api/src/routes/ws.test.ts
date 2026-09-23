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
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

// Lets one test make the socket's first workspace read throw.
const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("./workspace-view.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./workspace-view.js")>();
	return {
		...real,
		countActive: async (...args: Parameters<typeof real.countActive>) => {
			if (failRead.on) throw new Error("read failed");
			return real.countActive(...args);
		},
	};
});

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
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
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

	const update = socket.nextOf("workspace");
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();

	const message = await update;
	expect(message.workspace.state).toBe("running");

	await socket.close();
});

test.skipIf(skip)("archiving and unarchiving reach an open socket", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	for (const archivedAt of [new Date().toISOString(), null]) {
		const update = socket.nextOf("workspace");
		// Only archived_at changes, so nothing else could trigger the push.
		await testDb.db
			.updateTable("workspaces")
			.set({ archived_at: archivedAt })
			.where("id", "=", workspaceId)
			.execute();
		const message = await update;
		expect(message.workspace.archivedAt === null).toBe(archivedAt === null);
	}

	await socket.close();
});

test.skipIf(skip)("shutting the server down closes sockets with 1001", async () => {
	const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await socket.next();

	const closed = nextClose(socket);
	await app.close();
	expect(await closed).toBe(1001);
});

test.skipIf(skip)(
	"deleting the session closes an idle socket with 4401 within a second",
	async () => {
		const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await socket.next();

		const closed = nextClose(socket);
		await testDb.db.deleteFrom("sessions").execute();

		// No heartbeat is sent; the watcher tick has to notice on its own.
		expect(await closed).toBe(4401);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await countConnections()).toBe(0);
	},
);

test.skipIf(skip)("a workspace refuses more than sixteen connections", async () => {
	const open: Array<Awaited<ReturnType<typeof openWorkspaceSocket>>> = [];
	try {
		for (let i = 0; i < 16; i += 1) {
			const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
			await socket.next();
			open.push(socket);
		}
		expect(await countConnections()).toBe(16);

		await expect(
			openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL),
		).rejects.toMatchObject({ status: 429 });
	} finally {
		for (const socket of open) {
			await socket.close();
		}
	}
});

test.skipIf(skip)(
	"an administrator's socket on a student's workspace is not presence",
	async () => {
		const carol = new CookieJar();
		await loginAs(app, "carol", carol);
		const socket = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		const message = (await socket.next()) as Record<string, unknown>;
		expect(message.type).toBe("workspace");
		socket.ws.send(JSON.stringify({ type: "heartbeat" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(await countConnections()).toBe(0);
		const row = await testDb.db
			.selectFrom("workspaces")
			.select(["desired_state", "last_active_connection_at"])
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(row.desired_state).toBe("stopped");
		expect(row.last_active_connection_at).toBeNull();

		await socket.close();
	},
);

test.skipIf(skip)("an administrator is capped at sixteen sockets too", async () => {
	const carol = new CookieJar();
	await loginAs(app, "carol", carol);
	const open: OpenSocket[] = [];
	try {
		for (let i = 0; i < 16; i += 1) {
			const socket = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
			await socket.next();
			open.push(socket);
		}
		await expect(
			openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL),
		).rejects.toMatchObject({ status: 429 });

		// Closing one frees a slot.
		await open.pop()?.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const again = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		await again.next();
		open.push(again);
	} finally {
		for (const socket of open) {
			await socket.close();
		}
	}
});

test.skipIf(skip)(
	"an administrator socket whose first read throws still releases its slot",
	async () => {
		const carol = new CookieJar();
		await loginAs(app, "carol", carol);
		failRead.on = true;
		try {
			for (let i = 0; i < 16; i += 1) {
				const socket = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
				expect(await nextClose(socket)).toBe(1011);
			}
		} finally {
			failRead.on = false;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		// Had any slot leaked, sixteen leaks would refuse this with 429.
		const socket = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		await socket.next();
		await socket.close();
	},
);

async function archive(state: string): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({ state, desired_state: "stopped", archived_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
}

async function desiredState(): Promise<string> {
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("desired_state")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	return row.desired_state;
}

test.skipIf(skip)(
	"a reconnect right after archive does not undo the stop",
	async () => {
		await archive("running");
		const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await socket.next();
		expect(await desiredState()).toBe("stopped");
		await socket.close();
	},
);

test.skipIf(skip)(
	"opening a stopped archived workspace does not start it",
	async () => {
		await archive("stopped");
		const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await socket.next();
		expect(await desiredState()).toBe("stopped");
		await socket.close();
	},
);
