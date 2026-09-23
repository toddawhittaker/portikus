import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	openWorkspaceSocket,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * WebSocket authorization and isolation (SPEC.md §5.3, §5.4, §6.4):
 * one student's socket must never see another student's workspace, and
 * the server must not leak watchers or rows when sockets go away.
 */

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

async function sessionFor(
	user: string,
): Promise<{ jar: CookieJar; workspaceId: string }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	return { jar, workspaceId };
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
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)(
	"an upgrade to a workspace id that is not a uuid is 400",
	async () => {
		const { jar } = await sessionFor("alice");
		await expect(
			openWorkspaceSocket(app, "not-a-uuid", jar, PUBLIC_URL),
		).rejects.toMatchObject({ status: 400 });
	},
);

test.skipIf(skip)("an upgrade with no Origin header at all is refused", async () => {
	const { jar, workspaceId } = await sessionFor("alice");
	await expect(
		openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL, { origin: "" }),
	).rejects.toMatchObject({ status: 403 });
});

test.skipIf(skip)(
	"a valid session with the wrong Origin cannot upgrade to its own workspace",
	async () => {
		const { jar, workspaceId } = await sessionFor("alice");
		await expect(
			openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL, {
				origin: "https://evil.example.com",
			}),
		).rejects.toMatchObject({ status: 403 });
		const rows = await testDb.db
			.selectFrom("workspace_connections")
			.selectAll()
			.execute();
		expect(rows).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"two students on two workspaces only ever see their own broadcasts",
	async () => {
		const alice = await sessionFor("alice");
		const bob = await sessionFor("bob");

		const aliceSocket = await openWorkspaceSocket(
			app,
			alice.workspaceId,
			alice.jar,
			PUBLIC_URL,
		);
		const bobSocket = await openWorkspaceSocket(
			app,
			bob.workspaceId,
			bob.jar,
			PUBLIC_URL,
		);

		const aliceFirst = (await aliceSocket.next()) as {
			workspace: { id: string };
		};
		const bobFirst = (await bobSocket.next()) as { workspace: { id: string } };
		expect(aliceFirst.workspace.id).toBe(alice.workspaceId);
		expect(bobFirst.workspace.id).toBe(bob.workspaceId);

		const aliceUpdate = aliceSocket.nextOf("workspace");
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "running", updated_at: new Date().toISOString() })
			.where("id", "=", alice.workspaceId)
			.execute();

		const message = await aliceUpdate;
		expect(message.workspace.id).toBe(alice.workspaceId);
		expect(message.workspace.state).toBe("running");

		// Bob's socket must still have seen nothing but his own workspace.
		for (const seen of bobSocket.messages) {
			if (seen.type !== "workspace") continue;
			expect(seen.workspace.id).toBe(bob.workspaceId);
		}

		await aliceSocket.close();
		await bobSocket.close();
	},
);

test.skipIf(skip)(
	"a revoked session closes the socket and removes its connection row",
	async () => {
		const { jar, workspaceId } = await sessionFor("alice");
		const socket = await openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL);
		await socket.next();

		await testDb.db.deleteFrom("sessions").execute();

		const closed = new Promise<number>((resolve) => {
			socket.ws.addEventListener("close", (event) => resolve(event.code), {
				once: true,
			});
		});
		socket.ws.send(JSON.stringify({ type: "heartbeat" }));
		expect(await closed).toBe(4401);

		// The socket closes as soon as the server calls close(), but the row is
		// deleted by a later database call, so poll for it.
		await vi.waitFor(
			async () => {
				const rows = await testDb.db
					.selectFrom("workspace_connections")
					.selectAll()
					.execute();
				expect(rows).toHaveLength(0);
			},
			{ timeout: 3000, interval: 50 },
		);
	},
);

test.skipIf(skip)(
	"a socket survives malformed and unknown messages but still heartbeats",
	async () => {
		const { jar, workspaceId } = await sessionFor("alice");
		const socket = await openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL);
		await socket.next();

		for (const junk of [
			"not json",
			"[]",
			"null",
			JSON.stringify({ type: "shutdown" }),
			JSON.stringify({ type: 17 }),
		]) {
			socket.ws.send(junk);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(socket.ws.readyState).toBe(WebSocket.OPEN);

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
	},
);

test.skipIf(skip)(
	"two sockets share one watcher and closing the last one clears it",
	async () => {
		const { jar, workspaceId } = await sessionFor("alice");

		const started = vi.spyOn(globalThis, "setInterval");
		const cleared = vi.spyOn(globalThis, "clearInterval");
		try {
			const first = await openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL);
			await first.next();
			const second = await openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL);
			await second.next();

			expect(started).toHaveBeenCalledTimes(1);
			const handle = started.mock.results[0]?.value;

			await first.close();
			await new Promise((resolve) => setTimeout(resolve, 200));
			// One socket is still open, so the shared watcher must keep polling.
			expect(cleared).not.toHaveBeenCalledWith(handle);

			await second.close();
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(cleared).toHaveBeenCalledWith(handle);

			const rows = await testDb.db
				.selectFrom("workspace_connections")
				.selectAll()
				.execute();
			expect(rows).toHaveLength(0);
		} finally {
			started.mockRestore();
			cleared.mockRestore();
		}
	},
);

test.skipIf(skip)("the server shuts down promptly with a socket open", async () => {
	const { jar, workspaceId } = await sessionFor("alice");
	const socket = await openWorkspaceSocket(app, workspaceId, jar, PUBLIC_URL);
	await socket.next();

	const started = Date.now();
	await app.close();
	expect(Date.now() - started).toBeLessThan(3000);
});
