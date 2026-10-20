import { createSession } from "@portikus/auth";
import { AdminCoursesResponse } from "@portikus/contracts";
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
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/** The administrator's course list and profile switch (SPEC.md §8.7, §20.1). */

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

function put(courseId: string, cookie: string, payload: unknown, origin = PUBLIC_URL) {
	return app.inject({
		method: "PUT",
		url: `/admin/courses/${courseId}/profile`,
		headers: { cookie, origin },
		payload: payload as object,
	});
}

async function seed() {
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	const student = await insertTestUser(testDb.db);
	const ivy = await insertTestLtiUser(testDb.db, undefined, { role: "instructor" });
	const zoology = await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "zoo",
		title: "Zoology",
		role: "instructor",
	});
	const algebra = await insertTestLtiMembership(testDb.db, ivy, {
		contextId: "alg",
		title: "Algebra",
		role: "instructor",
	});
	return { admin, student, ivy, zoology, algebra };
}

test.skipIf(skip)(
	"an administrator lists every course by title with its profile",
	async () => {
		const { admin, zoology, algebra } = await seed();
		await testDb.db
			.updateTable("lti_contexts")
			.set({ profile: "traditional" })
			.where("id", "=", zoology)
			.execute();
		const res = await app.inject({
			url: "/admin/courses",
			headers: { cookie: await cookieFor(admin) },
		});
		expect(res.statusCode).toBe(200);
		expect(AdminCoursesResponse.parse(res.json())).toEqual([
			{ id: algebra, title: "Algebra", platformName: "Test LMS", profile: "agentic" },
			{
				id: zoology,
				title: "Zoology",
				platformName: "Test LMS",
				profile: "traditional",
			},
		]);
	},
);

test.skipIf(skip)("an administrator sets a profile with an audit row", async () => {
	const { admin, algebra } = await seed();
	const res = await put(algebra, await cookieFor(admin), { profile: "traditional" });
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({ id: algebra, profile: "traditional" });

	const rows = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "course.profile_changed")
		.execute();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		actor: `user:${admin}`,
		target: algebra,
		result: "ok",
		metadata: { from: "agentic", to: "traditional" },
	});
});

test.skipIf(skip)(
	"the admin course routes refuse students, instructors, anonymous callers, bad input and no CSRF",
	async () => {
		const { admin, student, ivy, algebra } = await seed();
		const body = { profile: "traditional" };
		for (const [name, userId] of [
			["a student", student],
			["an instructor", ivy],
		] as const) {
			const cookie = await cookieFor(userId);
			expect((await put(algebra, cookie, body)).statusCode, name).toBe(403);
			const list = await app.inject({ url: "/admin/courses", headers: { cookie } });
			expect(list.statusCode, name).toBe(403);
		}
		expect((await app.inject({ url: "/admin/courses" })).statusCode).toBe(401);
		const anonymous = await app.inject({
			method: "PUT",
			url: `/admin/courses/${algebra}/profile`,
			headers: { origin: PUBLIC_URL },
			payload: body,
		});
		expect(anonymous.statusCode).toBe(401);

		const cookie = await cookieFor(admin);
		expect((await put(algebra, cookie, { profile: "hybrid" })).statusCode).toBe(400);
		expect((await put(algebra, cookie, body, "https://evil.example")).statusCode).toBe(
			403,
		);
		expect((await put(crypto.randomUUID(), cookie, body)).statusCode).toBe(404);
		expect((await put("not-a-uuid", cookie, body)).statusCode).toBe(404);

		const stored = await testDb.db
			.selectFrom("lti_contexts")
			.select("profile")
			.where("id", "=", algebra)
			.executeTakeFirstOrThrow();
		expect(stored.profile).toBe("agentic");
		const audits = await testDb.db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "course.profile_changed")
			.execute();
		expect(audits).toEqual([]);
	},
);
