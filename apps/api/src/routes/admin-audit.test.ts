import { randomUUID } from "node:crypto";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AuditPage } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let carol: CookieJar;

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
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	// Only the rows each test seeds.
	await testDb.db.deleteFrom("audit_events").execute();
	return async () => {
		await app.close();
	};
});

async function userId(subject: string): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", subject)
		.executeTakeFirstOrThrow();
	return row.id;
}

async function seed(
	rows: { actor: string; target: string; action: string; result?: string }[],
): Promise<void> {
	await testDb.db
		.insertInto("audit_events")
		.values(rows.map((row) => ({ result: "ok", metadata: null, ...row })))
		.execute();
}

async function getAudit(query: string, jar: CookieJar = carol) {
	return app.inject({
		method: "GET",
		url: `/admin/audit${query}`,
		headers: { cookie: jar.cookieHeader() },
	});
}

test.skipIf(skip)("only an administrator may read the audit log", async () => {
	expect((await app.inject({ method: "GET", url: "/admin/audit" })).statusCode).toBe(
		401,
	);
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	expect((await getAudit("", alice)).statusCode).toBe(403);
	expect((await getAudit("")).statusCode).toBe(200);
});

test.skipIf(skip)("pages newest first in fifties through before=<id>", async () => {
	const target = randomUUID();
	await seed(
		Array.from({ length: 120 }, (_, i) => ({
			actor: "worker",
			target,
			action: `workspace.step_${i}`,
		})),
	);

	const seen: number[] = [];
	let before: number | null = null;
	let pages = 0;
	do {
		const res = await getAudit(before === null ? "" : `?before=${before}`);
		expect(res.statusCode).toBe(200);
		const page = AuditPage.parse(res.json());
		pages++;
		seen.push(...page.events.map((event) => event.id));
		before = page.nextBefore;
	} while (before !== null);

	expect(pages).toBe(3);
	expect(seen).toHaveLength(120);
	expect(seen).toEqual([...seen].sort((a, b) => b - a));
	expect(new Set(seen).size).toBe(120);
});

test.skipIf(skip)("filters by workspace, user and action prefix", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	await testDb.db.deleteFrom("audit_events").execute();
	const aliceId = await userId("alice");
	const carolId = await userId("carol");
	const workspace = randomUUID();
	const other = randomUUID();
	await seed([
		{
			actor: `user:${aliceId}`,
			target: workspace,
			action: "workspace.start_requested",
		},
		{ actor: "worker", target: workspace, action: "workspace.start" },
		{ actor: "worker", target: other, action: "workspace.start" },
		{ actor: `user:${carolId}`, target: aliceId, action: "user.disabled" },
		{
			actor: `user:${carolId}`,
			target: "settings",
			action: "settings.log_level_updated",
		},
		// The prefix is matched literally, so its dot is not a wildcard.
		{ actor: "worker", target: other, action: "workspaceXstart" },
	]);

	const byWorkspace = AuditPage.parse(
		(await getAudit(`?workspace=${workspace}`)).json(),
	);
	expect(byWorkspace.events.map((event) => event.action)).toEqual([
		"workspace.start",
		"workspace.start_requested",
	]);

	const byUser = AuditPage.parse((await getAudit(`?user=${aliceId}`)).json());
	expect(byUser.events.map((event) => event.action)).toEqual([
		"user.disabled",
		"workspace.start_requested",
	]);
	expect(byUser.events[0]?.actorName).toBe("Carol Admin");
	expect(byUser.events[1]?.actorName).toBe("Alice Student");

	const byAction = AuditPage.parse((await getAudit("?action=workspace.")).json());
	expect(byAction.events).toHaveLength(3);
	expect(byAction.events.every((event) => event.action.startsWith("workspace."))).toBe(
		true,
	);

	const combined = AuditPage.parse(
		(await getAudit(`?workspace=${other}&action=workspace.start`)).json(),
	);
	expect(combined.events).toHaveLength(1);
	expect(combined.nextBefore).toBeNull();
});

test.skipIf(skip)("a malformed query is 400", async () => {
	expect((await getAudit("?workspace=nope")).statusCode).toBe(400);
	expect((await getAudit("?before=-1")).statusCode).toBe(400);
	expect((await getAudit("?unknown=1")).statusCode).toBe(400);
});

test.skipIf(skip)(
	"every user actor the code writes resolves to a name (#600 item 7)",
	async () => {
		// Real sign-ins write their own audit rows through the production code.
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		await loginAs(app, "carol", carol);
		const events = AuditPage.parse((await getAudit("")).json()).events;
		const userActors = events.filter((event) => event.actor.startsWith("user:"));
		expect(userActors.length).toBeGreaterThan(0);
		for (const event of userActors) expect(event.actorName).not.toBeNull();
		// A bare id as actor would not resolve; no code path writes one.
		for (const event of events) expect(event.actor).not.toMatch(/^[0-9a-f]{8}-/);
	},
);
