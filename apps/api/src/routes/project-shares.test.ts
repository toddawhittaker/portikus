import {
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	ProjectList,
	ProjectShareStatus,
	SHARE_DURATION_HOURS,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The student's side of a project share (SPEC.md §5.2, §24.11, ADR 0057):
 * one open share per project, 24 hours long, started and stopped only by
 * the owner, each audited.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "project-shares-agent-token";
const HOUR_MS = 3_600_000;

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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.ready();
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	return () => app.close();
});

function shareUrl(suffix = "") {
	return `/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}/share${suffix}`;
}

function asA(method: "GET" | "POST", url: string) {
	return app.inject({
		method,
		url,
		headers:
			method === "GET"
				? { cookie: world.a.jar.cookieHeader() }
				: csrfHeaders(world.a.jar, PUBLIC_URL),
	});
}

async function auditActions(): Promise<string[]> {
	const rows = await testDb.db
		.selectFrom("audit_events")
		.select("action")
		.where("action", "like", "project.share_%")
		.orderBy("id")
		.execute();
	return rows.map((row) => row.action);
}

test.skipIf(skip)("nothing is shared until the owner starts a share", async () => {
	const res = await asA("GET", shareUrl());
	expect(res.statusCode).toBe(200);
	expect(ProjectShareStatus.parse(res.json())).toEqual({ share: null, viewers: [] });
});

test.skipIf(skip)("a share lasts 24 hours, and starting again keeps it", async () => {
	const started = await asA("POST", shareUrl());
	expect(started.statusCode).toBe(200);
	const status = ProjectShareStatus.parse(started.json());
	if (!status.share) throw new Error("no share");
	const length = Date.parse(status.share.endsAt) - Date.parse(status.share.startedAt);
	expect(length).toBe(SHARE_DURATION_HOURS * HOUR_MS);
	expect(status.viewers).toEqual([]);

	const again = ProjectShareStatus.parse((await asA("POST", shareUrl())).json());
	expect(again.share?.id).toBe(status.share.id);
	expect(ProjectShareStatus.parse((await asA("GET", shareUrl())).json())).toEqual(
		status,
	);
	expect(await auditActions()).toEqual(["project.share_started"]);
	const audit = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "project.share_started")
		.executeTakeFirstOrThrow();
	expect(audit.actor).toBe(`user:${world.a.userId}`);
	expect(audit.target).toBe(world.a.projectId);
});

test.skipIf(skip)(
	"starting closes an expired share that still holds the slot",
	async () => {
		const expired = await testDb.db
			.insertInto("project_shares")
			.values({
				project_id: world.a.projectId,
				started_at: new Date(Date.now() - 30 * HOUR_MS).toISOString(),
				ends_at: new Date(Date.now() - 6 * HOUR_MS).toISOString(),
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		expect(ProjectShareStatus.parse((await asA("GET", shareUrl())).json()).share).toBe(
			null,
		);

		const started = ProjectShareStatus.parse((await asA("POST", shareUrl())).json());
		expect(started.share).not.toBe(null);
		expect(started.share?.id).not.toBe(expired.id);
		const old = await testDb.db
			.selectFrom("project_shares")
			.select("ended_at")
			.where("id", "=", expired.id)
			.executeTakeFirstOrThrow();
		expect(old.ended_at).not.toBe(null);
	},
);

test.skipIf(skip)("stopping ends the share and is audited once", async () => {
	await asA("POST", shareUrl());
	const stopped = await asA("POST", shareUrl("/stop"));
	expect(stopped.statusCode).toBe(200);
	expect(ProjectShareStatus.parse(stopped.json())).toEqual({
		share: null,
		viewers: [],
	});
	const open = await testDb.db
		.selectFrom("project_shares")
		.select("id")
		.where("ended_at", "is", null)
		.execute();
	expect(open).toEqual([]);

	// Nothing open: still 200, and nothing more is audited.
	expect((await asA("POST", shareUrl("/stop"))).statusCode).toBe(200);
	expect(await auditActions()).toEqual([
		"project.share_started",
		"project.share_stopped",
	]);
});

test.skipIf(skip)("the owner sees which instructors looked, by name", async () => {
	await asA("POST", shareUrl());
	const view = await app.inject({
		url: `/courses/${world.courseId}/shares/${world.a.projectId}/tree`,
		headers: { cookie: world.instructor.cookieHeader() },
	});
	expect(view.statusCode).toBe(200);
	const status = ProjectShareStatus.parse((await asA("GET", shareUrl())).json());
	expect(status.viewers.map((viewer) => viewer.displayName)).toEqual([
		"Ivy Instructor",
	]);
	// A new share starts with no viewers.
	await asA("POST", shareUrl("/stop"));
	const fresh = ProjectShareStatus.parse((await asA("POST", shareUrl())).json());
	expect(fresh.viewers).toEqual([]);
});

test.skipIf(skip)("an archived project cannot be shared", async () => {
	await testDb.db
		.updateTable("projects")
		.set({ state: "archived", archived_at: new Date().toISOString() })
		.where("id", "=", world.a.projectId)
		.execute();
	const res = await asA("POST", shareUrl());
	expect(res.statusCode).toBe(400);
	const rows = await testDb.db.selectFrom("project_shares").select("id").execute();
	expect(rows).toEqual([]);
});

test.skipIf(skip)("nobody but the owner reaches the share routes", async () => {
	await asA("POST", shareUrl());
	for (const jar of [world.b.jar, world.instructor, world.admin]) {
		const read = await app.inject({
			url: shareUrl(),
			headers: { cookie: jar.cookieHeader() },
		});
		expect(read.statusCode).toBe(404);
		const stop = await app.inject({
			method: "POST",
			url: shareUrl("/stop"),
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(stop.statusCode).toBe(404);
	}
	expect(
		ProjectShareStatus.parse((await asA("GET", shareUrl())).json()).share,
	).not.toBe(null);
});

function setProjectState(state: "active" | "archived") {
	return app.inject({
		method: "PATCH",
		url: `/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}`,
		headers: csrfHeaders(world.a.jar, PUBLIC_URL),
		payload: { state },
	});
}

test.skipIf(skip)(
	"archiving ends the share, and unarchiving never brings it back",
	async () => {
		await asA("POST", shareUrl());
		expect((await setProjectState("archived")).statusCode).toBe(200);
		expect((await setProjectState("active")).statusCode).toBe(200);

		expect(ProjectShareStatus.parse((await asA("GET", shareUrl())).json()).share).toBe(
			null,
		);
		const open = await testDb.db
			.selectFrom("project_shares")
			.select("id")
			.where("ended_at", "is", null)
			.execute();
		expect(open).toEqual([]);
		const stopped = await testDb.db
			.selectFrom("audit_events")
			.select(["metadata"])
			.where("action", "=", "project.share_stopped")
			.execute();
		expect(stopped).toHaveLength(1);
		expect(stopped[0]?.metadata).toMatchObject({ reason: "archived" });
		const view = await app.inject({
			url: `/courses/${world.courseId}/shares/${world.a.projectId}/tree`,
			headers: { cookie: world.instructor.cookieHeader() },
		});
		expect(view.statusCode).toBe(404);
	},
);

test.skipIf(skip)(
	"the project list says until when each project is shared",
	async () => {
		const sharedUntilOfA = async () => {
			const res = await app.inject({
				url: `/workspaces/${world.a.workspaceId}/projects`,
				headers: { cookie: world.a.jar.cookieHeader() },
			});
			const body = ProjectList.parse(res.json());
			return body.projects.find((one) => one.id === world.a.projectId)?.sharedUntil;
		};
		expect(await sharedUntilOfA()).toBe(null);

		const status = ProjectShareStatus.parse((await asA("POST", shareUrl())).json());
		expect(await sharedUntilOfA()).toBe(status.share?.endsAt);

		// An expired share is not shown, even before anything closes it.
		await testDb.db.deleteFrom("project_shares").execute();
		await testDb.db
			.insertInto("project_shares")
			.values({
				project_id: world.a.projectId,
				started_at: new Date(Date.now() - 25 * HOUR_MS).toISOString(),
				ends_at: new Date(Date.now() - HOUR_MS).toISOString(),
			})
			.execute();
		expect(await sharedUntilOfA()).toBe(null);
	},
);
