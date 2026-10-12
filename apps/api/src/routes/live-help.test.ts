import type { AddressInfo } from "node:net";
import {
	type CookieJar,
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	CloseCode,
	CourseLiveHelpDetail,
	CourseLiveHelpResponse,
	LiveHelpStatus,
	MAX_TERMINAL_SOCKETS_PER_USER,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { liveHelpSockets } from "../live-help/registry.js";
import { LIVE_HELP_STARTED_TITLE } from "../live-help/sessions.js";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";

/**
 * Live help, both sides (ADR 0063, SPEC.md §24.6, §24.11). In the matrix
 * world the instructor teaches the course A belongs to; B is in no course.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "live-help-agent-token";
const ORIGIN = new URL(PUBLIC_URL).origin;

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
	return () => app.close();
});

function post(jar: CookieJar, url: string, payload?: object) {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload === undefined ? {} : { payload }),
	});
}

async function start(
	payload: object = { helperUserId: helperId, courseId: world.courseId },
) {
	return post(
		world.a.jar,
		`/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}/live-help`,
		payload,
	);
}

async function startedId(): Promise<string> {
	const res = await start();
	expect(res.statusCode, res.body).toBe(200);
	const status = LiveHelpStatus.parse(res.json());
	return status.session?.id ?? "";
}

/** A's browser counts as open while this row is fresh (SPEC.md §6.4). */
async function studentConnected(): Promise<void> {
	await testDb.db
		.insertInto("workspace_connections")
		.values({ workspace_id: world.a.workspaceId })
		.execute();
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

function detailUrl(sid: string, courseId = world.courseId) {
	return `/courses/${courseId}/live-help/${sid}`;
}

function socketPath(sid: string, terminalId = world.a.terminalId) {
	return `${detailUrl(sid)}/terminals/${terminalId}/ws`;
}

/** The HTTP status an upgrade was refused with, or 101. */
async function upgradeStatus(path: string, cookie: string): Promise<number> {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
		headers: { cookie, origin: ORIGIN },
	});
	return new Promise<number>((resolve) => {
		socket.once("open", () => {
			socket.close();
			resolve(101);
		});
		socket.once("unexpected-response", (_request, response) => {
			resolve(response.statusCode ?? 0);
			socket.terminate();
		});
		socket.once("error", () => resolve(0));
	});
}

interface Attached {
	socket: WebSocket;
	closed: Promise<number>;
	frames: string[];
}

async function attach(sid: string, cookie = world.instructor.cookieHeader()) {
	const { port } = app.server.address() as AddressInfo;
	const socket = new WebSocket(
		`ws://127.0.0.1:${port}${socketPath(sid)}?cols=100&rows=30`,
		{
			headers: { cookie, origin: ORIGIN },
		},
	);
	const frames: string[] = [];
	socket.on("message", (data) => frames.push(data.toString()));
	const closed = new Promise<number>((resolve) => socket.once("close", resolve));
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("unexpected-response", (_r, response) =>
			reject(new Error(`upgrade answered ${response.statusCode}`)),
		);
	});
	// The fake's size frame arrives once the agent socket is open.
	await expect.poll(() => frames.some((one) => one.includes('"size"'))).toBe(true);
	return { socket, closed, frames } satisfies Attached;
}

/** Frames the fake agent received since `mark`, a length of its list. */
function receivedSince(mark: number): string[] {
	return agent.received.slice(mark);
}

describe.skipIf(skip)("starting live help", () => {
	test("opens a session with typing off, audits ids only, and tells the helper", async () => {
		const res = await start();
		expect(res.statusCode, res.body).toBe(200);
		const status = LiveHelpStatus.parse(res.json());
		expect(status.session).toMatchObject({
			projectId: world.a.projectId,
			projectName: world.a.projectName,
			courseId: world.courseId,
			helper: { userId: helperId, displayName: "Ivy Instructor" },
			typing: false,
		});
		const minutes =
			(Date.parse(status.session?.endsAt ?? "") -
				Date.parse(status.session?.startedAt ?? "")) /
			60_000;
		expect(Math.round(minutes)).toBe(60);
		expect(status.audience).toEqual([
			{
				courseId: world.courseId,
				courseTitle: "Test Course",
				instructors: [{ userId: helperId, displayName: "Ivy Instructor" }],
			},
		]);

		const [row] = await audits("project.live_help_started");
		expect(row).toMatchObject({
			actor: `user:${world.a.userId}`,
			target: world.a.projectId,
		});
		expect(row?.metadata).toEqual({
			sessionId: status.session?.id,
			helperId,
			contextId: world.courseId,
			endsAt: status.session?.endsAt,
		});

		const notices = await testDb.db
			.selectFrom("notifications")
			.selectAll()
			.where("user_id", "=", helperId)
			.execute();
		expect(notices.map((one) => one.title)).toEqual([LIVE_HELP_STARTED_TITLE]);
	});

	test("refuses a helper who does not teach the course, or a course the student is not in", async () => {
		// B is a student of no course; naming B as helper is refused.
		expect(
			(await start({ helperUserId: world.b.userId, courseId: world.courseId }))
				.statusCode,
		).toBe(400);
		// The student cannot name themself.
		await insertTestLtiMembership(testDb.db, world.a.userId, {
			contextId: "course-a-teaches",
			role: "instructor",
		});
		expect(
			(await start({ helperUserId: world.a.userId, courseId: world.courseId }))
				.statusCode,
		).toBe(400);
		// The instructor teaches a second course A is not in.
		const other = await insertTestLtiMembership(testDb.db, helperId, {
			contextId: "course-2",
			role: "instructor",
		});
		expect((await start({ helperUserId: helperId, courseId: other })).statusCode).toBe(
			400,
		);
		expect(await audits("project.live_help_started")).toEqual([]);
	});

	test("allows one open session per workspace", async () => {
		await startedId();
		const again = await start();
		expect(again.statusCode).toBe(409);
		expect(again.json().code).toBe("LIVE_HELP_OPEN");
	});

	test("refuses an archived project", async () => {
		await testDb.db
			.updateTable("projects")
			.set({ state: "archived" })
			.where("id", "=", world.a.projectId)
			.execute();
		expect((await start()).statusCode).toBe(400);
	});

	test("is the owner's alone", async () => {
		const res = await post(
			world.b.jar,
			`/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}/live-help`,
			{ helperUserId: helperId, courseId: world.courseId },
		);
		expect(res.statusCode).toBe(404);
	});
});

describe.skipIf(skip)("the gate", () => {
	async function detail(sid: string, cookie: string, courseId = world.courseId) {
		return app.inject({ url: detailUrl(sid, courseId), headers: { cookie } });
	}

	test("lets the helper read the session, its terminals, and whether the student is there", async () => {
		const sid = await startedId();
		const before = await detail(sid, world.instructor.cookieHeader());
		expect(before.statusCode).toBe(200);
		expect(before.headers["cache-control"]).toBe("no-store");
		const body = CourseLiveHelpDetail.parse(before.json());
		expect(body.studentConnected).toBe(false);
		expect(body.terminals).toEqual([
			{ id: world.a.terminalId, name: world.a.terminalName },
		]);
		expect(body.session).toMatchObject({
			id: sid,
			userId: world.a.userId,
			typing: false,
		});

		await studentConnected();
		const after = CourseLiveHelpDetail.parse(
			(await detail(sid, world.instructor.cookieHeader())).json(),
		);
		expect(after.studentConnected).toBe(true);

		const list = await app.inject({
			url: `/courses/${world.courseId}/live-help`,
			headers: { cookie: world.instructor.cookieHeader() },
		});
		expect(
			CourseLiveHelpResponse.parse(list.json()).sessions.map((one) => one.id),
		).toEqual([sid]);
	});

	test("is 404 for another instructor of the course, the owner and an administrator", async () => {
		const sid = await startedId();
		await insertTestLtiMembership(testDb.db, world.b.userId, { role: "instructor" });
		for (const cookie of [
			world.b.jar.cookieHeader(),
			world.a.jar.cookieHeader(),
			world.admin.cookieHeader(),
		]) {
			expect((await detail(sid, cookie)).statusCode).toBe(404);
			expect(await upgradeStatus(socketPath(sid), cookie)).toBe(404);
		}
		// The other instructor's own list does not show it either.
		const list = await app.inject({
			url: `/courses/${world.courseId}/live-help`,
			headers: { cookie: world.b.jar.cookieHeader() },
		});
		expect(list.json()).toEqual({ sessions: [] });
	});

	test("is 404 under another course id", async () => {
		const sid = await startedId();
		const other = await insertTestLtiMembership(testDb.db, helperId, {
			contextId: "course-2",
			role: "instructor",
		});
		expect((await detail(sid, world.instructor.cookieHeader(), other)).statusCode).toBe(
			404,
		);
	});

	test("is 404 for an ended, an expired, and an archived project's session", async () => {
		const helper = world.instructor.cookieHeader();
		const ended = await startedId();
		await post(world.a.jar, `/workspaces/${world.a.workspaceId}/live-help/stop`);
		expect((await detail(ended, helper)).statusCode).toBe(404);

		const expired = await startedId();
		await testDb.db
			.updateTable("live_help_sessions")
			.set({
				started_at: new Date(Date.now() - 7_200_000).toISOString(),
				ends_at: new Date(Date.now() - 1000).toISOString(),
			} as never)
			.where("id", "=", expired)
			.execute();
		expect((await detail(expired, helper)).statusCode).toBe(404);

		await testDb.db
			.updateTable("live_help_sessions")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", expired)
			.execute();
		const archived = await startedId();
		await testDb.db
			.updateTable("projects")
			.set({ state: "archived" })
			.where("id", "=", world.a.projectId)
			.execute();
		expect((await detail(archived, helper)).statusCode).toBe(404);
	});

	test("is 404 for a terminal outside the session's project, and for an ended terminal", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = world.instructor.cookieHeader();
		// A terminal of A's with no project, and B's terminal.
		const loose = await post(
			world.a.jar,
			`/workspaces/${world.a.workspaceId}/terminals`,
			{
				name: "loose",
			},
		);
		expect(loose.statusCode).toBe(201);
		expect(await upgradeStatus(socketPath(sid, loose.json().id), helper)).toBe(404);
		expect(await upgradeStatus(socketPath(sid, world.b.terminalId), helper)).toBe(404);

		await testDb.db
			.updateTable("terminals")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", world.a.terminalId)
			.execute();
		expect(await upgradeStatus(socketPath(sid), helper)).toBe(404);
	});

	test("ends the session once the helper no longer teaches the course", async () => {
		const sid = await startedId();
		await testDb.db
			.deleteFrom("lti_memberships")
			.where("user_id", "=", helperId)
			.execute();
		expect((await detail(sid, world.instructor.cookieHeader())).statusCode).toBe(404);
		const [row] = await audits("project.live_help_ended");
		expect(row).toMatchObject({ actor: "platform" });
		expect(row?.metadata).toMatchObject({ sessionId: sid, reason: "helper_removed" });
	});

	test("refuses the socket with 409 while the workspace is stopped or the student is away", async () => {
		const sid = await startedId();
		const helper = world.instructor.cookieHeader();
		expect(await upgradeStatus(socketPath(sid), helper)).toBe(409);
		await studentConnected();
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped" })
			.where("id", "=", world.a.workspaceId)
			.execute();
		expect(await upgradeStatus(socketPath(sid), helper)).toBe(409);
	});
});

describe.skipIf(skip)("the helper's terminal socket", () => {
	test("in view mode carries output but no input, no resize, and no history", async () => {
		// Earlier output the student saw, which the helper must not get (D3).
		const seeded = await fetch(
			`http://127.0.0.1:${agent.port}/__test/terminals/${world.a.terminalId}/output`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lines: ["earlier-secret-line"] }),
			},
		);
		expect(seeded.status).toBe(204);
		const sid = await startedId();
		await studentConnected();
		const before = await testDb.db
			.selectFrom("workspace_connections")
			.select("id")
			.execute();
		const mark = agent.received.length;
		const helper = await attach(sid);
		expect(helper.frames.join("")).not.toContain("earlier-secret-line");
		const attachUrl = agent.requests
			.filter((one) => one.url.includes(`/terminals/${world.a.terminalId}/attach`))
			.at(-1)?.url;
		expect(attachUrl).toContain("mode=view");

		helper.socket.send(JSON.stringify({ type: "input", data: "rm -rf ~\r" }));
		helper.socket.send(JSON.stringify({ type: "resize", cols: 10, rows: 5 }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(receivedSince(mark)).toEqual([]);

		// The helper writes no presence, so it never keeps the workspace awake.
		const after = await testDb.db
			.selectFrom("workspace_connections")
			.select("id")
			.execute();
		expect(after).toEqual(before);

		const [opened] = await audits("project.live_help_terminal_opened");
		expect(opened).toMatchObject({
			actor: `user:${helperId}`,
			target: world.a.projectId,
		});
		expect(opened?.metadata).toEqual({
			sessionId: sid,
			terminalId: world.a.terminalId,
			mode: "view",
		});
		helper.socket.close();
		await helper.closed;
	});

	test("turning typing on closes the socket, and type mode forwards input only", async () => {
		const sid = await startedId();
		await studentConnected();
		const viewing = await attach(sid);
		const on = await post(
			world.a.jar,
			`/workspaces/${world.a.workspaceId}/live-help/typing`,
			{
				typing: true,
			},
		);
		expect(LiveHelpStatus.parse(on.json()).session?.typing).toBe(true);
		expect(await viewing.closed).toBe(CloseCode.LIVE_HELP_MODE_CHANGED);
		const [changed] = await audits("project.live_help_typing_changed");
		expect(changed?.metadata).toEqual({ sessionId: sid, typing: true });

		const mark = agent.received.length;
		const typing = await attach(sid);
		typing.socket.send(JSON.stringify({ type: "resize", cols: 10, rows: 5 }));
		typing.socket.send("not json");
		typing.socket.send(JSON.stringify({ type: "input", data: "ls\r" }));
		await expect.poll(() => receivedSince(mark).length).toBe(1);
		expect(receivedSince(mark)).toEqual([
			JSON.stringify({ type: "input", data: "ls\r" }),
		]);

		// Asking for what is already so changes nothing and closes nothing.
		await post(world.a.jar, `/workspaces/${world.a.workspaceId}/live-help/typing`, {
			typing: true,
		});
		expect(await audits("project.live_help_typing_changed")).toHaveLength(1);
		expect(typing.socket.readyState).toBe(WebSocket.OPEN);

		await post(world.a.jar, `/workspaces/${world.a.workspaceId}/live-help/typing`, {
			typing: false,
		});
		expect(await typing.closed).toBe(CloseCode.LIVE_HELP_MODE_CHANGED);
	});

	test("the student's stop closes it at once, audited with the duration", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = await attach(sid);
		const res = await post(
			world.a.jar,
			`/workspaces/${world.a.workspaceId}/live-help/stop`,
		);
		expect(LiveHelpStatus.parse(res.json()).session).toBeNull();
		expect(await helper.closed).toBe(CloseCode.LIVE_HELP_ENDED);
		const [row] = await audits("project.live_help_ended");
		expect(row).toMatchObject({ actor: `user:${world.a.userId}` });
		expect(row?.metadata).toMatchObject({ sessionId: sid, reason: "stopped" });
		expect(
			typeof (row?.metadata as { durationSeconds?: unknown } | undefined)
				?.durationSeconds,
		).toBe("number");
		expect(liveHelpSockets.open(sid)).toBe(0);
	});

	test("the helper's leave ends it", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = await attach(sid);
		const res = await post(world.instructor, `${detailUrl(sid)}/leave`);
		expect(res.statusCode).toBe(204);
		expect(await helper.closed).toBe(CloseCode.LIVE_HELP_ENDED);
		const [row] = await audits("project.live_help_ended");
		expect(row).toMatchObject({ actor: `user:${helperId}` });
		expect(row?.metadata).toMatchObject({ reason: "helper_left" });
		const status = await app.inject({
			url: `/workspaces/${world.a.workspaceId}/live-help`,
			headers: { cookie: world.a.jar.cookieHeader() },
		});
		expect(LiveHelpStatus.parse(status.json()).session).toBeNull();
	});

	test("archiving the project ends it", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = await attach(sid);
		const res = await app.inject({
			method: "PATCH",
			url: `/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}`,
			headers: csrfHeaders(world.a.jar, PUBLIC_URL),
			payload: { state: "archived" },
		});
		expect(res.statusCode, res.body).toBe(200);
		expect(await helper.closed).toBe(CloseCode.LIVE_HELP_ENDED);
		const [row] = await audits("project.live_help_ended");
		expect(row?.metadata).toMatchObject({ sessionId: sid, reason: "archived" });
	});

	test("a roster removal closes it within about a second", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = await attach(sid);
		await testDb.db
			.deleteFrom("lti_memberships")
			.where("user_id", "=", world.a.userId)
			.execute();
		const began = Date.now();
		// The check runs on a keystroke or once a second.
		expect(await helper.closed).toBe(CloseCode.LIVE_HELP_ENDED);
		expect(Date.now() - began).toBeLessThan(2500);
		const [row] = await audits("project.live_help_ended");
		expect(row?.metadata).toMatchObject({ sessionId: sid, reason: "helper_removed" });
	});

	test("the student going away closes it, and the session stays open", async () => {
		const sid = await startedId();
		await studentConnected();
		const helper = await attach(sid);
		await testDb.db.deleteFrom("workspace_connections").execute();
		expect(await helper.closed).toBe(CloseCode.POLICY);
		expect(await audits("project.live_help_ended")).toEqual([]);
		expect(
			(
				await app.inject({
					url: detailUrl(sid),
					headers: { cookie: world.instructor.cookieHeader() },
				})
			).statusCode,
		).toBe(200);
	});

	test("counts against the helper's own terminal socket limit", async () => {
		const sid = await startedId();
		await studentConnected();
		for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i++)
			terminalSockets.take(helperId);
		try {
			const { port } = app.server.address() as AddressInfo;
			const socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath(sid)}`, {
				headers: { cookie: world.instructor.cookieHeader(), origin: ORIGIN },
			});
			const code = await new Promise<number>((resolve) =>
				socket.once("close", resolve),
			);
			expect(code).toBe(CloseCode.TOO_MANY_SOCKETS);
			// A refused socket is not an attach.
			expect(await audits("project.live_help_terminal_opened")).toEqual([]);
		} finally {
			for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i++)
				terminalSockets.release(helperId);
		}
	});
});

describe.skipIf(skip)("expiry", () => {
	test("an expired session closes without an audit row and frees the workspace", async () => {
		const sid = await startedId();
		await testDb.db
			.updateTable("live_help_sessions")
			.set({
				started_at: new Date(Date.now() - 7_200_000).toISOString(),
				ends_at: new Date(Date.now() - 1000).toISOString(),
			} as never)
			.where("id", "=", sid)
			.execute();
		const status = await app.inject({
			url: `/workspaces/${world.a.workspaceId}/live-help`,
			headers: { cookie: world.a.jar.cookieHeader() },
		});
		expect(LiveHelpStatus.parse(status.json()).session).toBeNull();
		expect(await audits("project.live_help_ended")).toEqual([]);
		const row = await testDb.db
			.selectFrom("live_help_sessions")
			.select("ended_at")
			.where("id", "=", sid)
			.executeTakeFirstOrThrow();
		expect(row.ended_at).not.toBeNull();
		expect((await start()).statusCode).toBe(200);
	});

	test("typing with nothing open is 404", async () => {
		const res = await post(
			world.a.jar,
			`/workspaces/${world.a.workspaceId}/live-help/typing`,
			{
				typing: true,
			},
		);
		expect(res.statusCode).toBe(404);
	});
});
