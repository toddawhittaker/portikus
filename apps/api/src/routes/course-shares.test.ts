import {
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	CourseSharesResponse,
	type GitStatus,
	SharedChecksResponse,
	SharedGitDiffResponse,
	SharedGitStatusResponse,
	SharedTreeResponse,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";
import { SHARE_VIEWED_TITLE } from "../workspaces/shared-scope.js";

/**
 * An instructor's read-only view of a shared project (SPEC.md §5.2, §24.6,
 * §24.11, ADR 0057). In the matrix world the instructor teaches the course
 * A is a member of; B is in no course the instructor teaches.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "course-shares-agent-token";
const HOUR_MS = 3_600_000;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;
let instructorId: string;

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
	instructorId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "ivy")
			.executeTakeFirstOrThrow()
	).id;
	return () => app.close();
});

/** Open a 24-hour share of a project directly; a negative end has expired. */
async function share(projectId: string, endsInHours = 23): Promise<string> {
	const endsAt = Date.now() + endsInHours * HOUR_MS;
	const row = await testDb.db
		.insertInto("project_shares")
		.values({
			project_id: projectId,
			started_at: new Date(endsAt - 24 * HOUR_MS).toISOString(),
			ends_at: new Date(endsAt).toISOString(),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function keyOf(student: MatrixWorld["a"]): string {
	return student.agentToken.slice(AGENT_TOKEN.length + 1);
}

async function seedFile(student: MatrixWorld["a"], path: string, content = "x") {
	const res = await fetch(`http://127.0.0.1:${agent.port}/__test/files`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: keyOf(student),
			path: `${student.projectSlug}/${path}`,
			content,
		}),
	});
	expect(res.status).toBe(204);
}

async function seedGit(
	student: MatrixWorld["a"],
	status: GitStatus,
	diffs: Record<string, unknown>,
) {
	const res = await fetch(`http://127.0.0.1:${agent.port}/__test/git`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: keyOf(student),
			slug: student.projectSlug,
			status,
			diffs,
		}),
	});
	expect(res.status).toBe(204);
}

function sharedUrl(
	route: string,
	projectId = world.a.projectId,
	courseId = world.courseId,
) {
	return `/courses/${courseId}/shares/${projectId}/${route}`;
}

function asInstructor(url: string) {
	return app.inject({ url, headers: { cookie: world.instructor.cookieHeader() } });
}

function agentCalls(): number {
	return agent.requests.filter((one) => !one.url.startsWith("/listening/events"))
		.length;
}

const READS = [
	"tree",
	"file?path=notes.txt",
	"git/status",
	"git/diff?path=notes.txt",
	"checks",
];

describe.skipIf(skip)("the course's share list", () => {
	test("lists open shares of course members, for the course's instructors only", async () => {
		await share(world.a.projectId);
		const res = await asInstructor(`/courses/${world.courseId}/shares`);
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const body = CourseSharesResponse.parse(res.json());
		expect(body.shares).toEqual([
			expect.objectContaining({
				projectId: world.a.projectId,
				projectName: world.a.projectName,
				userId: world.a.userId,
				workspaceState: "running",
			}),
		]);

		for (const jar of [world.a.jar, world.b.jar, world.admin]) {
			const other = await app.inject({
				url: `/courses/${world.courseId}/shares`,
				headers: { cookie: jar.cookieHeader() },
			});
			expect(other.statusCode).toBe(404);
		}
	});

	test("leaves out ended, expired, archived and non-member shares", async () => {
		const ended = await share(world.a.projectId);
		await testDb.db
			.updateTable("project_shares")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", ended)
			.execute();
		await share(world.b.projectId);
		const res = await asInstructor(`/courses/${world.courseId}/shares`);
		expect(CourseSharesResponse.parse(res.json()).shares).toEqual([]);

		await share(world.a.projectId, -1);
		const expired = await asInstructor(`/courses/${world.courseId}/shares`);
		expect(CourseSharesResponse.parse(expired.json()).shares).toEqual([]);
	});
});

describe.skipIf(skip)("shared reads", () => {
	test("each read answers in the owner's shapes, no-store", async () => {
		await share(world.a.projectId);
		await seedFile(world.a, "notes.txt", "hello");
		const tree = await asInstructor(sharedUrl("tree"));
		expect(tree.statusCode).toBe(200);
		expect(SharedTreeResponse.parse(tree.json()).entries.map((e) => e.name)).toContain(
			"notes.txt",
		);
		const file = await asInstructor(sharedUrl("file?path=notes.txt"));
		expect(file.statusCode).toBe(200);
		expect(file.body).toBe("hello");
		expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
		const status = await asInstructor(sharedUrl("git/status"));
		expect(status.statusCode).toBe(200);
		SharedGitStatusResponse.parse(status.json());
		const diff = await asInstructor(sharedUrl("git/diff?path=notes.txt"));
		expect(diff.statusCode).toBe(200);
		SharedGitDiffResponse.parse(diff.json());
		const checks = await asInstructor(sharedUrl("checks"));
		expect(checks.statusCode).toBe(200);
		SharedChecksResponse.parse(checks.json());
		for (const res of [tree, file, status, diff, checks]) {
			expect(res.headers["cache-control"]).toBe("no-store");
		}
	});

	test("checks show names and the latest run, never the command", async () => {
		await share(world.a.projectId);
		const secret = "DEPLOY_PASSWORD=TOPSECRET ./deploy.sh";
		await seedFile(
			world.a,
			".portikus/checks.json",
			JSON.stringify({
				checks: [
					{ id: "deploy", name: "Deploy", command: secret },
					{ id: "tests", name: "Tests", command: "true" },
				],
			}),
		);
		// The owner runs one, so a latest run is there to relay.
		const run = await app.inject({
			method: "POST",
			url: `/workspaces/${world.a.workspaceId}/projects/${world.a.projectId}/checks/tests/runs`,
			headers: csrfHeaders(world.a.jar, PUBLIC_URL),
		});
		expect(run.statusCode).toBeLessThan(300);

		const res = await asInstructor(sharedUrl("checks"));
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain("TOPSECRET");
		expect(res.body).not.toContain("command");
		const body = SharedChecksResponse.parse(res.json());
		expect(body.checks.map((check) => [check.id, check.name])).toEqual([
			["deploy", "Deploy"],
			["tests", "Tests"],
		]);
		expect(body.checks[0]?.lastRun).toBe(null);
		expect(body.checks[1]?.lastRun).toMatchObject({ state: "passed", exitCode: 0 });
	});

	// The agent refuses and leaves out symlinks only when asked (SPEC.md §5.2).
	test("every tree, file and Git read asks the agent to refuse symlinks", async () => {
		await share(world.a.projectId);
		await seedFile(world.a, "notes.txt", "hello");
		const start = agent.requests.length;
		for (const route of READS) await asInstructor(sharedUrl(route));
		const urls = agent.requests
			.slice(start)
			.map((one) => one.url)
			.filter((url) => !url.startsWith("/listening/events"));
		const reads = urls.filter((url) => !url.includes("/checks"));
		expect(reads).toHaveLength(4);
		for (const url of reads) {
			expect(new URL(url, "http://agent").searchParams.get("nolinks")).toBe("1");
		}
	});

	test("never a download, and an inline file must be an image or PDF", async () => {
		await share(world.a.projectId);
		await seedFile(world.a, "notes.txt", "hello");
		const download = await asInstructor(sharedUrl("file?path=notes.txt&download=1"));
		expect(download.headers["content-disposition"]).toBeUndefined();
		const inline = await asInstructor(sharedUrl("file?path=notes.txt&inline=1"));
		expect(inline.statusCode).toBe(415);
	});

	test("a student not in the instructor's course: 404", async () => {
		await share(world.b.projectId);
		const before = agentCalls();
		for (const route of READS) {
			const res = await asInstructor(sharedUrl(route, world.b.projectId));
			expect(res.statusCode, route).toBe(404);
			expect(res.headers["cache-control"]).toBe("no-store");
		}
		expect(agentCalls()).toBe(before);
	});

	test("a share reached through a course the instructor does not teach: 404", async () => {
		// B shares in a course of its own; the instructor teaches only A's.
		const otherCourse = await insertTestLtiMembership(testDb.db, world.b.userId, {
			contextId: "course-2",
		});
		await share(world.a.projectId);
		await share(world.b.projectId);
		for (const route of READS) {
			const viaOther = await asInstructor(
				sharedUrl(route, world.a.projectId, otherCourse),
			);
			expect(viaOther.statusCode, route).toBe(404);
			const bViaOwn = await asInstructor(sharedUrl(route, world.b.projectId));
			expect(bViaOwn.statusCode, route).toBe(404);
		}
	});

	test("an ended, expired or missing share, or an archived project: 404", async () => {
		for (const route of READS) {
			expect((await asInstructor(sharedUrl(route))).statusCode, route).toBe(404);
		}
		const id = await share(world.a.projectId);
		await testDb.db
			.updateTable("project_shares")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", id)
			.execute();
		for (const route of READS) {
			expect((await asInstructor(sharedUrl(route))).statusCode, route).toBe(404);
		}
		await share(world.a.projectId, -1);
		for (const route of READS) {
			expect((await asInstructor(sharedUrl(route))).statusCode, route).toBe(404);
		}
		await testDb.db.deleteFrom("project_shares").execute();
		await share(world.a.projectId);
		await testDb.db
			.updateTable("projects")
			.set({ state: "archived", archived_at: new Date().toISOString() })
			.where("id", "=", world.a.projectId)
			.execute();
		for (const route of READS) {
			expect((await asInstructor(sharedUrl(route))).statusCode, route).toBe(404);
		}
	});

	test("the owner, other students and administrators get 404 here too", async () => {
		await share(world.a.projectId);
		for (const jar of [world.a.jar, world.b.jar, world.admin]) {
			for (const route of READS) {
				const res = await app.inject({
					url: sharedUrl(route),
					headers: { cookie: jar.cookieHeader() },
				});
				expect(res.statusCode, route).toBe(404);
			}
		}
	});
});

describe.skipIf(skip)("the secret filter", () => {
	const SECRETS = [
		".env",
		".env.local",
		"api/.env",
		"server.pem",
		"tls.key",
		"id_rsa",
		"id_ed25519.pub",
		".npmrc",
		".netrc",
		".pypirc",
		".portikus/checks.json",
		".git/config",
	];

	test("hides secrets in the tree, at the root and below", async () => {
		await share(world.a.projectId);
		for (const path of [...SECRETS, ".env.example", "api/main.py"]) {
			await seedFile(world.a, path);
		}
		const root = SharedTreeResponse.parse(
			(await asInstructor(sharedUrl("tree"))).json(),
		);
		expect(root.entries.map((entry) => entry.name).sort()).toEqual([
			".env.example",
			"api",
		]);
		const api = SharedTreeResponse.parse(
			(await asInstructor(sharedUrl("tree?path=api"))).json(),
		);
		expect(api.entries.map((entry) => entry.name)).toEqual(["main.py"]);
		for (const dir of [".git", ".portikus"]) {
			const res = await asInstructor(sharedUrl(`tree?path=${dir}`));
			expect(res.statusCode, dir).toBe(404);
			expect(res.body).not.toContain("config");
		}
	});

	test("refuses to read a secret file, and never asks the agent", async () => {
		await share(world.a.projectId);
		for (const path of SECRETS) await seedFile(world.a, path, "TOP-SECRET");
		await seedFile(world.a, ".env.example", "EXAMPLE=1");
		const before = agentCalls();
		for (const path of SECRETS) {
			const res = await asInstructor(
				sharedUrl(`file?path=${encodeURIComponent(path)}`),
			);
			expect(res.statusCode, path).toBe(404);
			expect(res.body).not.toContain("TOP-SECRET");
		}
		expect(agentCalls()).toBe(before);
		const example = await asInstructor(sharedUrl("file?path=.env.example"));
		expect(example.statusCode).toBe(200);
		expect(example.body).toBe("EXAMPLE=1");
	});

	test("hides secrets in Git status and refuses their diffs", async () => {
		await share(world.a.projectId);
		await seedGit(
			world.a,
			{
				repo: true,
				branch: "main",
				detached: false,
				upstream: null,
				ahead: 0,
				behind: 0,
				conflicts: 0,
				entries: [
					{ path: ".env", x: ".", y: "M", unmerged: false },
					{ path: "keys/id_rsa", x: "A", y: ".", unmerged: false },
					{ path: "config.txt", x: "R", y: ".", unmerged: false, origPath: ".env" },
					{ path: "main.py", x: ".", y: "M", unmerged: false },
				],
				ignored: [],
				truncated: false,
			},
			{
				".env": {
					status: "M",
					before: "TOP-SECRET",
					after: "TOP-SECRET-2",
					binary: false,
					tooLarge: false,
				},
				"config.txt": {
					status: "R",
					oldPath: ".env",
					before: "TOP-SECRET",
					after: "x",
					binary: false,
					tooLarge: false,
				},
				"main.py": {
					status: "M",
					before: "a",
					after: "b",
					binary: false,
					tooLarge: false,
				},
			},
		);
		const status = SharedGitStatusResponse.parse(
			(await asInstructor(sharedUrl("git/status"))).json(),
		);
		expect(status.entries.map((entry) => entry.path)).toEqual(["main.py"]);

		for (const path of [".env", "config.txt"]) {
			const res = await asInstructor(sharedUrl(`git/diff?path=${path}`));
			expect(res.statusCode, path).toBe(404);
			expect(res.body).not.toContain("TOP-SECRET");
		}
		const diff = await asInstructor(sharedUrl("git/diff?path=main.py"));
		expect(SharedGitDiffResponse.parse(diff.json()).after).toBe("b");
	});

	test("a path that leaves the project is refused before the agent", async () => {
		await share(world.a.projectId);
		const before = agentCalls();
		for (const route of [
			"tree?path=..",
			"tree?path=../other",
			"file?path=../../.ssh/id_ed25519",
			"file?path=%2Fetc%2Fpasswd",
			"file?path=a%2F..%2F..%2Fx",
			"git/diff?path=../x",
		]) {
			const res = await asInstructor(sharedUrl(route));
			expect(res.statusCode, route).toBe(400);
		}
		// The share check itself reads only the database; each refusal stops there.
		expect(agentCalls()).toBe(before);
	});
});

describe.skipIf(skip)("the view and the student's workspace", () => {
	test("a stopped workspace answers 409 and is never started", async () => {
		await share(world.a.projectId);
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped", desired_state: "stopped" })
			.where("id", "=", world.a.workspaceId)
			.execute();
		const before = agentCalls();
		for (const route of READS) {
			const res = await asInstructor(sharedUrl(route));
			expect(res.statusCode, route).toBe(409);
			expect(res.json().message).toBe("The workspace is stopped");
		}
		expect(agentCalls()).toBe(before);
		const row = await testDb.db
			.selectFrom("workspaces")
			.select(["desired_state", "state"])
			.where("id", "=", world.a.workspaceId)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ desired_state: "stopped", state: "stopped" });
		const list = await asInstructor(`/courses/${world.courseId}/shares`);
		expect(CourseSharesResponse.parse(list.json()).shares[0]?.workspaceState).toBe(
			"stopped",
		);
	});

	test("a view never counts as presence for the idle timer", async () => {
		await share(world.a.projectId);
		const before = await testDb.db
			.selectFrom("workspaces")
			.select(["last_active_connection_at", "desired_state", "updated_at"])
			.where("id", "=", world.a.workspaceId)
			.executeTakeFirstOrThrow();
		for (const route of READS) await asInstructor(sharedUrl(route));
		const after = await testDb.db
			.selectFrom("workspaces")
			.select(["last_active_connection_at", "desired_state", "updated_at"])
			.where("id", "=", world.a.workspaceId)
			.executeTakeFirstOrThrow();
		expect(after).toEqual(before);
		const connections = await testDb.db
			.selectFrom("workspace_connections")
			.select("id")
			.where("workspace_id", "=", world.a.workspaceId)
			.execute();
		expect(connections).toEqual([]);
	});

	test("the first view per instructor and share is audited and told; later ones are not", async () => {
		const shareId = await share(world.a.projectId);
		for (const route of READS) await asInstructor(sharedUrl(route));
		await asInstructor(sharedUrl("tree"));

		const audits = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "project.share_viewed")
			.execute();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.actor).toBe(`user:${instructorId}`);
		expect(audits[0]?.target).toBe(world.a.projectId);
		expect(audits[0]?.metadata).toEqual({ shareId, contextId: world.courseId });

		const notices = await testDb.db
			.selectFrom("notifications")
			.select(["user_id", "title", "body"])
			.where("title", "=", SHARE_VIEWED_TITLE)
			.execute();
		expect(notices).toEqual([
			{
				user_id: world.a.userId,
				title: SHARE_VIEWED_TITLE,
				body: `Ivy Instructor opened ${world.a.projectName}.`,
			},
		]);

		const views = await testDb.db
			.selectFrom("project_share_views")
			.selectAll()
			.where("share_id", "=", shareId)
			.execute();
		expect(views).toHaveLength(1);
		expect(views[0]?.viewer_user_id).toBe(instructorId);
		expect(new Date(views[0]?.last_viewed_at ?? 0).getTime()).toBeGreaterThanOrEqual(
			new Date(views[0]?.first_viewed_at ?? 0).getTime(),
		);

		// A new share is a new first view.
		await testDb.db
			.updateTable("project_shares")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", shareId)
			.execute();
		await share(world.a.projectId);
		await asInstructor(sharedUrl("tree"));
		const again = await testDb.db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "project.share_viewed")
			.execute();
		expect(again).toHaveLength(2);
	});

	test("a later view moves the last-looked time at most once a minute", async () => {
		const shareId = await share(world.a.projectId);
		await asInstructor(sharedUrl("tree"));
		async function setLastViewed(msAgo: number): Promise<string> {
			const at = new Date(Date.now() - msAgo).toISOString();
			await testDb.db
				.updateTable("project_share_views")
				.set({ last_viewed_at: at })
				.where("share_id", "=", shareId)
				.execute();
			return at;
		}
		async function lastViewed(): Promise<number> {
			const row = await testDb.db
				.selectFrom("project_share_views")
				.select("last_viewed_at")
				.where("share_id", "=", shareId)
				.executeTakeFirstOrThrow();
			return new Date(row.last_viewed_at).getTime();
		}

		const recent = await setLastViewed(30_000);
		for (const route of READS) await asInstructor(sharedUrl(route));
		expect(await lastViewed()).toBe(new Date(recent).getTime());

		const old = await setLastViewed(90_000);
		await asInstructor(sharedUrl("tree"));
		expect(await lastViewed()).toBeGreaterThan(new Date(old).getTime() + 60_000);
	});

	test("the share list alone is not a view", async () => {
		await share(world.a.projectId);
		await asInstructor(`/courses/${world.courseId}/shares`);
		const views = await testDb.db
			.selectFrom("project_share_views")
			.select("share_id")
			.execute();
		expect(views).toEqual([]);
	});
});
