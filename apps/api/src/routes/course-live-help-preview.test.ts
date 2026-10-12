import {
	type CookieJar,
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { LiveHelpStatus } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { clearPreviewLookups, createPreviewSession } from "../preview/store.js";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The helper's previews during live help (ADR 0063, SPEC.md §24.7): the
 * owner check is widened only through an open session the requester helps
 * on, and the helper never keeps the workspace awake.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "live-help-preview-agent-token";
const SUFFIX = "preview.localhost";
const COOKIE = "portikus-preview";
const PORT = 5173;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;
let helperId: string;

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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	helperId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "ivy")
			.executeTakeFirstOrThrow()
	).id;
	await seedListener();
	return () => app.close();
});

/** A's workspace listens on the preview port, with a secret on its command line. */
async function seedListener(
	extra: { port: number; previewReachability?: "unknown" }[] = [],
): Promise<void> {
	const key = world.a.agentToken.slice(AGENT_TOKEN.length + 1);
	const seeded = await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key,
			services: [
				{
					port: PORT,
					process: { pid: 7, command: "node", commandLine: "node --token=s3cret" },
					container: { id: "c0ffee", name: "student-db" },
				},
				...extra,
			],
		}),
	});
	expect(seeded.status).toBe(204);
	await expect
		.poll(async () => {
			const res = await app.inject({
				url: `/workspaces/${world.a.workspaceId}/listening`,
				headers: { cookie: world.a.jar.cookieHeader() },
			});
			const ports = (res.json().services ?? []) as { port: number }[];
			return ports.length === extra.length + 1;
		})
		.toBe(true);
}

async function startedId(): Promise<string> {
	const res = await app.inject({
		method: "POST",
		url: `/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}/live-help`,
		headers: csrfHeaders(world.a.jar, PUBLIC_URL),
		payload: { helperUserId: helperId, courseId: world.courseId },
	});
	expect(res.statusCode, res.body).toBe(200);
	// The gateway lets the helper in only while the student is there.
	await studentConnected();
	return LiveHelpStatus.parse(res.json()).session?.id ?? "";
}

/** The student ends live help, through the server that holds the one bridge. */
async function studentStops(): Promise<void> {
	const res = await app.inject({
		method: "POST",
		url: `/workspaces/${world.a.workspaceId}/live-help/stop`,
		headers: csrfHeaders(world.a.jar, PUBLIC_URL),
	});
	expect(res.statusCode, res.body).toBe(200);
}

/** A's browser counts as open while this row is fresh (SPEC.md §6.4). */
async function studentConnected(): Promise<void> {
	await testDb.db
		.insertInto("workspace_connections")
		.values({ workspace_id: world.a.workspaceId })
		.execute();
}

function base(sid: string): string {
	return `/courses/${world.courseId}/live-help/${sid}`;
}

function grant(jar: CookieJar, sid: string, port = PORT) {
	return app.inject({
		method: "POST",
		url: `${base(sid)}/preview-grants`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { port, presentation: "embedded" },
	});
}

function host(label = world.a.label): string {
	return `${label}-${PORT}.${SUFFIX}`;
}

/** The helper's grant, bootstrapped into a preview cookie. */
async function helperPreview(sid: string): Promise<string> {
	const created = await grant(world.instructor, sid);
	expect(created.statusCode, created.body).toBe(201);
	const ticket = new URL(created.json().bootstrapUrl).searchParams.get("t") ?? "";
	const done = await app.inject({
		url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
		headers: { "x-forwarded-host": host() },
	});
	expect(done.statusCode).toBe(303);
	const cookie = (done.cookies as { name: string; value: string }[]).find(
		(one) => one.name === COOKIE,
	);
	if (!cookie) throw new Error("no preview cookie was set");
	return cookie.value;
}

function authorize(
	token: string,
	previewHost = host(),
	userStarted = false,
	uri = "/",
) {
	return app.inject({
		url: "/preview/authorize",
		remoteAddress: "127.0.0.1",
		headers: {
			"x-forwarded-host": previewHost,
			"x-forwarded-method": "GET",
			"x-forwarded-uri": uri,
			"x-forwarded-proto": "https",
			cookie: `${COOKIE}=${token}`,
			...(userStarted ? { "sec-fetch-dest": "document", "sec-fetch-user": "?1" } : {}),
		},
	});
}

async function userIdOf(subject: string): Promise<string> {
	return (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", subject)
			.executeTakeFirstOrThrow()
	).id;
}

/**
 * A preview session tied to the live help session but held by someone else,
 * as if a grant had been forged for them: the gateway alone must refuse it.
 */
async function forgedSession(
	userId: string,
	sid: string,
	workspaceId = world.a.workspaceId,
	previewHost = host(),
): Promise<string> {
	const main = await testDb.db
		.selectFrom("sessions")
		.select("id")
		.where("user_id", "=", userId)
		.orderBy("created_at", "desc")
		.executeTakeFirstOrThrow();
	return createPreviewSession(testDb.db, {
		userId,
		sessionId: main.id,
		workspaceId,
		port: PORT,
		previewHost,
		liveHelpSessionId: sid,
	});
}

describe.skipIf(skip)("the helper's listening list", () => {
	test("lists A's ports with no process or container details", async () => {
		const sid = await startedId();
		const res = await app.inject({
			url: `${base(sid)}/listening`,
			headers: { cookie: world.instructor.cookieHeader() },
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const services = res.json().services as { port: number; process?: object }[];
		expect(services.map((one) => one.port)).toEqual([PORT]);
		expect(services[0]).not.toHaveProperty("process");
		expect(services[0]).not.toHaveProperty("container");
		expect(res.body).not.toContain("s3cret");
		expect(res.body).not.toContain("student-db");
	});

	test("is 404 for another instructor, the owner and an administrator", async () => {
		const sid = await startedId();
		await insertTestLtiMembership(testDb.db, world.b.userId, { role: "instructor" });
		for (const jar of [world.b.jar, world.a.jar, world.admin]) {
			const res = await app.inject({
				url: `${base(sid)}/listening`,
				headers: { cookie: jar.cookieHeader() },
			});
			expect(res.statusCode).toBe(404);
		}
	});
});

describe.skipIf(skip)("the helper's preview grants", () => {
	test("open a preview in view mode, audited with ids and the port", async () => {
		const sid = await startedId();
		const token = await helperPreview(sid);
		expect((await authorize(token)).statusCode).toBe(200);
		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "project.live_help_preview_opened")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toEqual({ sessionId: sid, port: PORT });
		expect(rows[0]?.target).toBe(world.a.projectId);
	});

	test("are refused to another instructor, the owner, an administrator and after the end", async () => {
		const sid = await startedId();
		await insertTestLtiMembership(testDb.db, world.b.userId, { role: "instructor" });
		for (const jar of [world.b.jar, world.a.jar, world.admin]) {
			expect((await grant(jar, sid)).statusCode).toBe(404);
		}
		await studentStops();
		expect((await grant(world.instructor, sid)).statusCode).toBe(404);
	});

	test("refuse a port policy denies", async () => {
		const sid = await startedId();
		expect((await grant(world.instructor, sid, 22)).statusCode).toBe(403);
	});
});

describe.skipIf(skip)("the gateway's owner check", () => {
	test("never records activity for the helper's navigations", async () => {
		const sid = await startedId();
		const token = await helperPreview(sid);
		await testDb.db
			.updateTable("workspaces")
			.set({ last_activity_at: null })
			.where("id", "=", world.a.workspaceId)
			.execute();
		expect((await authorize(token, host(), true)).statusCode).toBe(200);
		const row = await testDb.db
			.selectFrom("workspaces")
			.select("last_activity_at")
			.where("id", "=", world.a.workspaceId)
			.executeTakeFirstOrThrow();
		expect(row.last_activity_at).toBeNull();
	});

	test("stops letting the helper in the moment the session ends", async () => {
		const sid = await startedId();
		const token = await helperPreview(sid);
		// Warm the two-second lookup cache first.
		expect((await authorize(token)).statusCode).toBe(200);
		await studentStops();
		expect((await authorize(token)).statusCode).not.toBe(200);
	});

	test("refuses an ended session even when the preview session survived", async () => {
		const sid = await startedId();
		const token = await forgedSession(helperId, sid);
		await testDb.db
			.updateTable("live_help_sessions")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", sid)
			.execute();
		expect((await authorize(token)).statusCode).toBe(403);
	});

	test("refuses another instructor and an administrator holding the session id", async () => {
		const sid = await startedId();
		await insertTestLtiMembership(testDb.db, world.b.userId, { role: "instructor" });
		for (const subject of [world.b.userId, await userIdOf("carol")]) {
			const token = await forgedSession(subject, sid);
			expect((await authorize(token)).statusCode).toBe(403);
		}
	});

	test("refuses a session whose workspace is not the live help one", async () => {
		const sid = await startedId();
		const token = await forgedSession(
			helperId,
			sid,
			world.b.workspaceId,
			host(world.b.label),
		);
		expect((await authorize(token, host(world.b.label))).statusCode).toBe(403);
	});
});

describe.skipIf(skip)("the gateway's live checks on the helper", () => {
	test("refuses the helper once the student closes their workspace", async () => {
		const sid = await startedId();
		const token = await helperPreview(sid);
		expect((await authorize(token)).statusCode).toBe(200);
		await testDb.db.deleteFrom("workspace_connections").execute();
		// Past the two-second lookup cache.
		clearPreviewLookups();
		expect((await authorize(token)).statusCode).toBe(403);
	});

	test("refuses the helper once they no longer share the course", async () => {
		const sid = await startedId();
		const token = await helperPreview(sid);
		expect((await authorize(token)).statusCode).toBe(200);
		await testDb.db
			.deleteFrom("lti_memberships")
			.where("user_id", "=", world.a.userId)
			.execute();
		clearPreviewLookups();
		expect((await authorize(token)).statusCode).toBe(403);
	});

	test("ending live help closes the bridge forwards the helper's preview opened", async () => {
		await seedListener([{ port: 3000, previewReachability: "unknown" }]);
		const key = world.a.agentToken.slice(AGENT_TOKEN.length + 1);
		const sid = await startedId();
		const token = await helperPreview(sid);
		const bridged = await authorize(token, host(), false, "/__portikus/ports/3000/api");
		expect(bridged.statusCode, bridged.body).toBe(200);
		expect([...(agent.forwards.get(key) ?? [])]).toEqual([3000]);
		await studentStops();
		await expect.poll(() => agent.forwards.get(key)?.size ?? 0).toBe(0);
	});
});
