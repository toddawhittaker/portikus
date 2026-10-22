import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";

/** A course starts agentic and only the two profiles are stored (SPEC.md section 8.7). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0050 tests.");
}

describe.skipIf(!hasTestDb())("migration 0050_course_profile", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	function course(contextId: string, profile?: string) {
		return t.db
			.insertInto("lti_contexts")
			.values({
				platform_issuer: "https://lms.test.invalid",
				context_id: contextId,
				title: "Course",
				platform_name: "Test LMS",
				...(profile === undefined ? {} : { profile }),
			})
			.returning("profile")
			.executeTakeFirstOrThrow();
	}

	test("a new course is agentic", async () => {
		expect((await course("c1")).profile).toBe("agentic");
	});

	test("traditional is accepted and any other value is refused", async () => {
		expect((await course("c2", "traditional")).profile).toBe("traditional");
		await expect(course("c3", "classic")).rejects.toThrow(/lti_contexts_profile_check/);
	});
});
