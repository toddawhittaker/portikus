import { randomUUID } from "node:crypto";
import { createSession } from "@portikus/auth";
import { CourseStuckResponse } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer } from "../testing/test-support.js";
import { courseStuck } from "./course-stuck.js";

/** "Who is stuck?" for a course (SPEC.md section 20.5). */

const skip = !hasTestDb();
let testDb: TestDb;
let app: FastifyInstance;
const NOW = new Date("2026-11-16T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, "http://127.0.0.1:1/unused");
	await app.ready();
	return () => app.close();
});

async function get(url: string, userId: string) {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	return app.inject({ url, headers: { cookie: `portikus_session=${session.token}` } });
}

async function projectOf(
	userId: string,
): Promise<{ workspace: string; project: string }> {
	const ws = await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: userId,
			state: "running",
			label: `ws-${randomUUID().slice(0, 8)}`,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const project = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: ws.id,
			slug: "app",
			name: "app",
			path: "/home/student/projects/app",
			source: "new",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { workspace: ws.id, project: project.id };
}

/** Share the project with the student's courses, open for another day unless `ended`. */
async function share(projectId: string, ended = false) {
	await testDb.db
		.insertInto("project_shares")
		.values({
			project_id: projectId,
			ends_at: ended ? ago(1) : ago(-24),
		})
		.execute();
}

async function runs(
	projectId: string,
	list: [state: "passed" | "failed" | "error" | "stopped", hoursAgo: number][],
) {
	for (const [state, hours] of list) {
		await testDb.db
			.insertInto("check_runs")
			.values({
				project_id: projectId,
				check_id: "tests",
				agent_run_id: randomUUID(),
				state,
				started_at: ago(hours + 0.1),
				ended_at: ago(hours),
				exit_code: state === "passed" ? 0 : 1,
			})
			.execute();
	}
}

async function help(
	owner: { workspace: string; project: string },
	courseId: string,
	helper: string,
	startedHoursAgo: number,
	open: boolean,
) {
	await testDb.db
		.insertInto("live_help_sessions")
		.values({
			workspace_id: owner.workspace,
			project_id: owner.project,
			helper_user_id: helper,
			course_id: courseId,
			started_at: ago(startedHoursAgo),
			ends_at: open ? ago(-1) : ago(startedHoursAgo - 1),
			ended_at: open ? null : ago(startedHoursAgo - 0.5),
		})
		.execute();
}

async function usage(userId: string, daysAgo: number) {
	await testDb.db
		.insertInto("agent_usage_days")
		.values({
			user_id: userId,
			boot_id: randomUUID(),
			day: new Date(NOW.getTime() - daysAgo * 24 * HOUR).toISOString().slice(0, 10),
			agent: "claude",
			model: "m",
			sessions: 2,
			input_tokens: 100,
			output_tokens: 50,
			cache_read_tokens: 9999,
		})
		.execute();
}

/** Ivy teaches CS 101 to Sam, Pat and Quinn; Ned teaches CS 240, where Sam also is. */
async function seed() {
	const ivy = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Ivy",
		role: "instructor",
	});
	const ned = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Ned",
		role: "instructor",
	});
	const [sam, pat, quinn] = await Promise.all(
		["Sam", "Pat", "Quinn"].map((name) =>
			insertTestLtiUser(testDb.db, undefined, { display_name: name }),
		),
	);
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	const cs101 = await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "cs101",
		role: "instructor",
	});
	for (const student of [sam, pat, quinn] as string[])
		await insertTestLtiMembership(testDb.db, student, { contextId: "cs101" });
	const cs240 = await insertTestLtiMembership(testDb.db, ned, {
		contextId: "cs240",
		role: "instructor",
	});
	await insertTestLtiMembership(testDb.db, sam as string, { contextId: "cs240" });
	await testDb.db
		.updateTable("lti_memberships")
		.set({ last_launch_at: ago(24 * 10) })
		.execute();
	return { ivy, ned, sam, pat, quinn, admin, cs101, cs240 } as Record<string, string>;
}

test.skipIf(skip)(
	"ranks the most likely stuck first, from checks, live help and agent use",
	async () => {
		const { ivy, ned, sam, pat, quinn, cs101, cs240 } = await seed();
		const samWs = await projectOf(sam as string);
		await share(samWs.project);
		// A pass, then failures and an error since; a stopped run neither breaks nor adds.
		await runs(samWs.project, [
			["passed", 5],
			["failed", 4],
			["error", 3],
			["stopped", 2.5],
			["failed", 2],
		]);
		await help(samWs, cs101 as string, ivy as string, 48, false);
		await help(samWs, cs101 as string, ivy as string, 1, true);
		// Another course's help, and help older than 7 days, do not count.
		await help(samWs, cs240 as string, ned as string, 3, false);
		await help(samWs, cs101 as string, ivy as string, 24 * 9, false);
		const patWs = await projectOf(pat as string);
		await share(patWs.project);
		await runs(patWs.project, [
			["failed", 6],
			["passed", 3],
		]);
		await usage(pat as string, 0);
		await usage(pat as string, 6);
		await usage(pat as string, 8);

		const result = CourseStuckResponse.parse(
			await courseStuck(testDb.db, cs101 as string, NOW),
		);
		expect(result.students.map((s) => s.displayName)).toEqual(["Sam", "Quinn", "Pat"]);
		const [first, second, third] = result.students;
		expect(first).toMatchObject({
			userId: sam,
			failingStreak: 3,
			lastCheckAt: ago(2),
			liveHelpOpen: 1,
			liveHelpRecent: 2,
			agentSessions: 0,
			lastActivityAt: ago(1),
			reasons: [
				"has live help open",
				"3 failed checks in a row",
				"asked for help twice in 7 days",
			],
		});
		expect(second).toMatchObject({
			userId: quinn,
			failingStreak: 0,
			lastCheckAt: null,
			lastActivityAt: ago(24 * 10),
			reasons: ["no activity in 7 days"],
		});
		// Input plus output tokens over the last 7 days, cache reads left out.
		expect(third).toMatchObject({
			failingStreak: 0,
			agentSessions: 4,
			agentTokens: 300,
			reasons: [],
		});
	},
);

test.skipIf(skip)(
	"checks count only on projects shared with the course; agent use is overall",
	async () => {
		const { sam, pat, cs101 } = await seed();
		// A personal project, and a share that has ended, stay private.
		const personal = await projectOf(sam as string);
		await runs(personal.project, [
			["failed", 3],
			["failed", 2],
			["failed", 1],
		]);
		const ended = await projectOf(pat as string);
		await share(ended.project, true);
		await runs(ended.project, [
			["failed", 3],
			["failed", 2],
			["failed", 1],
		]);
		await usage(sam as string, 0);

		const { students } = await courseStuck(testDb.db, cs101 as string, NOW);
		for (const userId of [sam, pat]) {
			expect(students.find((s) => s.userId === userId)).toMatchObject({
				failingStreak: 0,
				lastCheckAt: null,
			});
		}
		expect(students.find((s) => s.userId === sam)).toMatchObject({ agentSessions: 2 });
	},
);

test.skipIf(skip)("only the course's instructors get it", async () => {
	const { ivy, ned, sam, admin, cs101 } = await seed();
	const url = `/courses/${cs101}/stuck`;
	const ok = await get(url, ivy as string);
	expect(ok.statusCode).toBe(200);
	expect(CourseStuckResponse.parse(ok.json()).students).toHaveLength(3);
	for (const other of [ned, sam, admin]) {
		expect((await get(url, other as string)).statusCode).toBe(404);
	}
	expect((await get("/courses/not-a-uuid/stuck", ivy as string)).statusCode).toBe(404);
});

test.skipIf(skip)("a course with no students answers an empty list", async () => {
	const ivy = await insertTestUser(testDb.db, { role: "instructor" });
	const course = await insertTestLtiMembership(testDb.db, ivy, { role: "instructor" });
	expect(await courseStuck(testDb.db, course, NOW)).toEqual({ days: 7, students: [] });
});
