import { createSession, hashSessionToken } from "@portikus/auth";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadMainSessionUser } from "./store.js";

const skip = !hasTestDb();
let testDb: TestDb;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (!skip) await testDb.close();
});

beforeEach(async () => {
	if (!skip) await testDb.truncate();
});

async function sessionId(
	userId: string,
	method: "oidc" | "lti",
	courseUserId: string | null = null,
): Promise<string> {
	const { token } = await createSession(testDb.db, userId, 600, {
		method,
		courseUserId,
	});
	return hashSessionToken(token);
}

// The preview gateway applies the same rules as loadSession (review N5).
describe.skipIf(skip)("loadMainSessionUser", () => {
	test("returns the user of a live session", async () => {
		const user = await insertTestUser(testDb.db);
		expect(
			(await loadMainSessionUser(testDb.db, await sessionId(user, "oidc")))?.id,
		).toBe(user);
	});

	test("refuses a launch session whose account is an administrator", async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const course = await insertTestLtiUser(testDb.db);
		const id = await sessionId(admin, "lti", course);
		expect(await loadMainSessionUser(testDb.db, id)).toBeNull();
	});

	test("refuses a course account retired by a link", async () => {
		const sso = await insertTestUser(testDb.db);
		const course = await insertTestLtiUser(testDb.db);
		const id = await sessionId(course, "lti");
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: course,
				user_id: sso,
				platform_issuer: "https://lms.test.invalid",
				archived_at: null,
			})
			.execute();
		expect(await loadMainSessionUser(testDb.db, id)).toBeNull();
	});
});
