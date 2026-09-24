import { createSession } from "@portikus/auth";
import { CourseMembersResponse, CoursesResponse } from "@portikus/contracts";
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
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/** The Course page API (docs/EPIC-13.md ruling 23). */

const skip = !hasTestDb();
let testDb: TestDb;
let app: FastifyInstance;

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

async function cookieFor(userId: string): Promise<string> {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	return `portikus_session=${session.token}`;
}

function get(url: string, cookie?: string) {
	return app.inject({ url, headers: cookie ? { cookie } : {} });
}

function remove(courseId: string, userId: string, cookie: string, origin = PUBLIC_URL) {
	return app.inject({
		method: "POST",
		url: `/courses/${courseId}/members/${userId}/remove`,
		headers: { cookie, origin },
	});
}

async function memberIds(contextId: string): Promise<string[]> {
	const rows = await testDb.db
		.selectFrom("lti_memberships")
		.select("user_id")
		.where("context_id", "=", contextId)
		.execute();
	return rows.map((row) => row.user_id).sort();
}

/** Ivy teaches CS 101 (with Sam and Tom) and is a student in CS 240. */
async function seed() {
	const ivy = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Ivy Instructor",
		email: "ivy@example.edu",
		role: "instructor",
	});
	const sam = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Sam Student",
		email: "sam@example.edu",
	});
	const tom = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Tom Assistant",
		role: "instructor",
	});
	const lee = await insertTestLtiUser(testDb.db, undefined, {
		display_name: "Lee Learner",
	});
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	const cs101 = await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "cs101",
		title: "CS 101",
		role: "instructor",
	});
	await insertTestLtiMembership(testDb.db, sam, {
		contextId: "cs101",
		title: "CS 101",
	});
	await insertTestLtiMembership(testDb.db, tom, {
		contextId: "cs101",
		title: "CS 101",
		role: "instructor",
	});
	const cs240 = await insertTestLtiMembership(testDb.db, lee, {
		contextId: "cs240",
		title: "CS 240",
		role: "instructor",
	});
	await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "cs240",
		title: "CS 240",
	});
	await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: sam,
			incus_instance_name: "ws-sam",
			label: "sam-label",
			state: "running",
			desired_state: "running",
			quota_config: JSON.stringify({}),
		})
		.execute();
	return { ivy, sam, tom, lee, admin, cs101, cs240 };
}

test.skipIf(skip)(
	"GET /courses lists only the courses the caller teaches",
	async () => {
		const { ivy, sam, admin, cs101 } = await seed();
		const mine = await get("/courses", await cookieFor(ivy));
		expect(mine.statusCode).toBe(200);
		expect(CoursesResponse.parse(mine.json())).toEqual([
			{ id: cs101, title: "CS 101", platformName: "Test LMS" },
		]);
		for (const other of [sam, admin]) {
			const res = await get("/courses", await cookieFor(other));
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual([]);
		}
		expect((await get("/courses")).statusCode).toBe(401);
	},
);

test.skipIf(skip)(
	"members are sorted by role then name, with user ids but no emails",
	async () => {
		const { ivy, sam, cs101 } = await seed();
		const res = await get(`/courses/${cs101}/members`, await cookieFor(ivy));
		expect(res.statusCode).toBe(200);
		const body = CourseMembersResponse.parse(res.json());
		expect(body.course).toEqual({
			id: cs101,
			title: "CS 101",
			platformName: "Test LMS",
		});
		expect(body.members.map((m) => [m.role, m.displayName, m.workspaceState])).toEqual([
			["instructor", "Ivy Instructor", null],
			["instructor", "Tom Assistant", null],
			["student", "Sam Student", "running"],
		]);
		expect(Object.keys(body.members[0] ?? {}).sort()).toEqual([
			"displayName",
			"lastLaunchAt",
			"role",
			"userId",
			"workspaceState",
		]);
		expect(body.members.map((m) => m.userId)).toContain(sam);
		expect(body.members.map((m) => m.userId)).toContain(ivy);
		for (const secret of ["@example.edu", "sam-label", "subject-", "ws-sam"]) {
			expect(res.body).not.toContain(secret);
		}
	},
);

test.skipIf(skip)(
	"members answer 404 to anyone but an instructor of that course",
	async () => {
		const { sam, admin, ivy, cs101, cs240 } = await seed();
		const cases: Array<[string, string]> = [
			// A student of the course.
			[`/courses/${cs101}/members`, await cookieFor(sam)],
			// An administrator.
			[`/courses/${cs101}/members`, await cookieFor(admin)],
			// Ivy is only a student in CS 240.
			[`/courses/${cs240}/members`, await cookieFor(ivy)],
			[`/courses/${crypto.randomUUID()}/members`, await cookieFor(ivy)],
			["/courses/not-a-uuid/members", await cookieFor(ivy)],
		];
		for (const [url, cookie] of cases) {
			const res = await get(url, cookie);
			expect(res.statusCode, url).toBe(404);
			expect(res.body).not.toContain("Sam Student");
		}
		expect((await get(`/courses/${cs101}/members`)).statusCode).toBe(401);
	},
);

test.skipIf(skip)(
	"an instructor removes one student's membership and nothing else",
	async () => {
		const { ivy, sam, tom, cs101 } = await seed();
		const res = await remove(cs101, sam, await cookieFor(ivy));
		expect(res.statusCode).toBe(200);
		expect(await memberIds(cs101)).toEqual([ivy, tom].sort());
		// The account and the workspace stay.
		const user = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("id", "=", sam)
			.executeTakeFirst();
		expect(user).toBeDefined();
		const ws = await testDb.db
			.selectFrom("workspaces")
			.select("state")
			.where("owner_user_id", "=", sam)
			.executeTakeFirstOrThrow();
		expect(ws.state).toBe("running");

		const events = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "course.member_removed")
			.execute();
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.actor).toBe(`user:${ivy}`);
		expect(event?.target).toBe(sam);
		expect(event?.result).toBe("ok");
		const text = JSON.stringify(event);
		expect(text).toContain(cs101);
		for (const pii of ["Sam", "Ivy", "@example.edu", "subject-"]) {
			expect(text).not.toContain(pii);
		}

		// Gone now, so a second remove is a 404.
		expect((await remove(cs101, sam, await cookieFor(ivy))).statusCode).toBe(404);
	},
);

test.skipIf(skip)(
	"removing is refused for students, other courses, yourself, instructors, non-members and without CSRF",
	async () => {
		const { ivy, sam, tom, lee, admin, cs101, cs240 } = await seed();
		const before101 = await memberIds(cs101);
		const before240 = await memberIds(cs240);
		const cases: Array<[string, Awaited<ReturnType<typeof remove>>, number]> = [
			["a student of the course", await remove(cs101, tom, await cookieFor(sam)), 404],
			["an administrator", await remove(cs101, sam, await cookieFor(admin)), 404],
			// Lee teaches CS 240, not CS 101.
			[
				"another course's instructor",
				await remove(cs101, sam, await cookieFor(lee)),
				404,
			],
			// Ivy is only a student in CS 240.
			["a student elsewhere", await remove(cs240, lee, await cookieFor(ivy)), 404],
			["yourself", await remove(cs101, ivy, await cookieFor(ivy)), 400],
			// Tom co-teaches CS 101: instructors are the LMS's to manage (review S4).
			["another instructor", await remove(cs101, tom, await cookieFor(ivy)), 400],
			["a non-member", await remove(cs101, lee, await cookieFor(ivy)), 404],
			[
				"an unknown user",
				await remove(cs101, crypto.randomUUID(), await cookieFor(ivy)),
				404,
			],
			["a bad id", await remove(cs101, "not-a-uuid", await cookieFor(ivy)), 404],
			[
				"a foreign Origin",
				await remove(cs101, sam, await cookieFor(ivy), "https://evil.example"),
				403,
			],
		];
		for (const [name, res, status] of cases) {
			expect(res.statusCode, name).toBe(status);
		}
		const instructor = cases.find(([name]) => name === "another instructor")?.[1];
		expect(instructor?.json().message).toBe(
			"Only students can be removed from a course. Instructors are managed in the LMS.",
		);
		const anonymous = await app.inject({
			method: "POST",
			url: `/courses/${cs101}/members/${sam}/remove`,
			headers: { origin: PUBLIC_URL },
		});
		expect(anonymous.statusCode).toBe(401);
		expect(await memberIds(cs101)).toEqual(before101);
		expect(await memberIds(cs240)).toEqual(before240);
		const events = await testDb.db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "course.member_removed")
			.execute();
		expect(events).toEqual([]);
	},
);
