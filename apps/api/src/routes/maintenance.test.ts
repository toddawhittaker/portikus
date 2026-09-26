import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, FastifyReply } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { claimLongOperation, releaseLongOperation } from "./project-scope.js";

/**
 * Reset Docker and Rebuild requests (SPEC.md §16.4, §17.2; ADR 0021). The
 * API records the operation and audits the request; the worker runs it.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;

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
	await app.ready();
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
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

function resetDocker(jar: CookieJar) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/reset-docker`,
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

function rebuild(jar: CookieJar, payload: unknown) {
	return app.inject({
		method: "POST",
		url: `/admin/workspaces/${workspaceId}/rebuild`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: payload as Record<string, unknown>,
	});
}

async function workspaceRow() {
	return testDb.db
		.selectFrom("workspaces")
		.selectAll()
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
}

function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

test.skipIf(skip)("the owner asks for Reset Docker and it is recorded", async () => {
	const response = await resetDocker(alice);
	expect(response.statusCode).toBe(202);

	const row = await workspaceRow();
	expect(row.pending_operation).toBe("reset-docker");
	expect(row.pending_operation_at).not.toBeNull();
	expect(row.pending_operation_by).toBe(row.owner_user_id);
	// The worker drives the operation; the request never touches state.
	expect(row.state).toBe("provisioning");

	const audit = await auditRows("workspace.docker_reset_requested");
	expect(audit).toHaveLength(1);
	expect(audit[0]?.target).toBe(workspaceId);
	expect(audit[0]?.actor).toBe(`user:${row.owner_user_id}`);

	const shown = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(shown.json().pendingOperation).toBe("reset-docker");
});

test.skipIf(skip)("a second operation is refused while one is pending", async () => {
	expect((await resetDocker(alice)).statusCode).toBe(202);
	const again = await resetDocker(alice);
	expect(again.statusCode).toBe(409);
	expect(again.json().code).toBe("OPERATION_PENDING");
	const rebuildToo = await rebuild(carol, { resetDocker: false });
	expect(rebuildToo.statusCode).toBe(409);
	expect(rebuildToo.json().code).toBe("OPERATION_PENDING");
	expect((await workspaceRow()).pending_operation).toBe("reset-docker");
	expect(await auditRows("workspace.docker_reset_requested")).toHaveLength(1);
});

test.skipIf(skip)(
	"another student cannot reset Docker; an administrator can",
	async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const refused = await resetDocker(bob);
		expect(refused.statusCode).toBe(404);
		expect((await workspaceRow()).pending_operation).toBeNull();

		expect((await resetDocker(carol)).statusCode).toBe(202);
		expect((await workspaceRow()).pending_operation).toBe("reset-docker");
	},
);

test.skipIf(skip)("only an administrator may rebuild", async () => {
	const refused = await rebuild(alice, { resetDocker: false });
	expect(refused.statusCode).toBe(403);
	expect((await workspaceRow()).pending_operation).toBeNull();
	expect(await auditRows("workspace.rebuild_requested")).toHaveLength(0);

	const accepted = await rebuild(carol, { resetDocker: false });
	expect(accepted.statusCode).toBe(202);
	expect((await workspaceRow()).pending_operation).toBe("rebuild");
	const audit = await auditRows("workspace.rebuild_requested");
	expect(audit).toHaveLength(1);
	expect(audit[0]?.metadata).toMatchObject({ resetDocker: false });
});

test.skipIf(skip)("a rebuild can reset Docker as well", async () => {
	expect((await rebuild(carol, { resetDocker: true })).statusCode).toBe(202);
	expect((await workspaceRow()).pending_operation).toBe("rebuild-reset-docker");
	const audit = await auditRows("workspace.rebuild_requested");
	expect(audit[0]?.metadata).toMatchObject({ resetDocker: true });
});

test.skipIf(skip)(
	"a rebuild needs an explicit resetDocker and a real workspace",
	async () => {
		expect((await rebuild(carol, {})).statusCode).toBe(400);
		expect((await rebuild(carol, { resetDocker: "yes" })).statusCode).toBe(400);
		const missing = await app.inject({
			method: "POST",
			url: `/admin/workspaces/${crypto.randomUUID()}/rebuild`,
			headers: csrfHeaders(carol, PUBLIC_URL),
			payload: { resetDocker: false },
		});
		expect(missing.statusCode).toBe(404);
	},
);

test.skipIf(skip)(
	"Reset Docker and Rebuild wait out a restore or other long operation",
	async () => {
		// The reply is only used when the claim fails, which it cannot here.
		expect(claimLongOperation(workspaceId, {} as FastifyReply)).toBe(true);
		try {
			for (const response of [
				await resetDocker(alice),
				await rebuild(carol, { resetDocker: false }),
			]) {
				expect(response.statusCode).toBe(409);
				expect(response.json().code).toBe("OPERATION_IN_PROGRESS");
			}
			expect((await workspaceRow()).pending_operation).toBeNull();
		} finally {
			releaseLongOperation(workspaceId);
		}
		expect((await resetDocker(alice)).statusCode).toBe(202);
	},
);

test.skipIf(skip)(
	"rebuilding two workspaces in turn audits each with the administrator as actor",
	async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const bobWorkspaceId = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(bob, PUBLIC_URL),
			})
		).json().id as string;
		// Bulk Rebuild in the admin view calls the single route once per workspace (EPIC-18 ruling 24).
		for (const id of [workspaceId, bobWorkspaceId]) {
			const response = await app.inject({
				method: "POST",
				url: `/admin/workspaces/${id}/rebuild`,
				headers: csrfHeaders(carol, PUBLIC_URL),
				payload: { resetDocker: false },
			});
			expect(response.statusCode).toBe(202);
		}
		const carolId = (
			await testDb.db
				.selectFrom("users")
				.select("id")
				.where("oidc_subject", "=", "carol")
				.executeTakeFirstOrThrow()
		).id;
		const audit = await auditRows("workspace.rebuild_requested");
		expect(audit.map((row) => row.target).sort()).toEqual(
			[workspaceId, bobWorkspaceId].sort(),
		);
		expect(audit.every((row) => row.actor === `user:${carolId}`)).toBe(true);
	},
);

test.skipIf(skip)("a rebuild without CSRF headers is refused", async () => {
	const response = await app.inject({
		method: "POST",
		url: `/admin/workspaces/${workspaceId}/rebuild`,
		headers: { cookie: carol.cookieHeader() },
		payload: { resetDocker: false },
	});
	expect(response.statusCode).toBe(403);
	expect((await workspaceRow()).pending_operation).toBeNull();
	expect(await auditRows("workspace.rebuild_requested")).toHaveLength(0);
});
