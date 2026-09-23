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
import { buildTestServer } from "../test-support.js";

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
	const session = await createSession(testDb.db, userId, 3600);
	return `portikus_session=${session.token}`;
}

function get(url: string, cookie?: string) {
	return app.inject({ url, headers: cookie ? { cookie } : {} });
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
	"members are sorted by role then name, with no ids or emails",
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
			"workspaceState",
		]);
		for (const secret of [
			ivy,
			sam,
			"@example.edu",
			"sam-label",
			"subject-",
			"ws-sam",
		]) {
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
