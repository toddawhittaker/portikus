import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { effectiveProfile, setCourseProfile } from "./profile.js";

/** Which profile a person gets, and the audited change of a course's profile (SPEC.md §8.7). */

const skip = !hasTestDb();
let testDb: TestDb;

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
});

/** A course with this profile, taught by an instructor of its own; returns its id and context id. */
async function course(contextId: string, profile: "agentic" | "traditional") {
	const teacher = await insertTestLtiUser(testDb.db, undefined, { role: "instructor" });
	const id = await insertTestLtiMembership(testDb.db, teacher, {
		contextId,
		role: "instructor",
	});
	await testDb.db
		.updateTable("lti_contexts")
		.set({ profile })
		.where("id", "=", id)
		.execute();
	return { id, contextId };
}

/** A student-role user with a student seat in each given course. */
async function student(...courses: Array<{ contextId: string }>) {
	const id = await insertTestLtiUser(testDb.db);
	for (const { contextId } of courses) {
		await insertTestLtiMembership(testDb.db, id, { contextId });
	}
	return { id, role: "student" as const };
}

describe("effectiveProfile", () => {
	test.skipIf(skip)("a user in no course gets the whole interface", async () => {
		expect(await effectiveProfile(testDb.db, await student())).toBe("agentic");
	});

	test.skipIf(skip)("a student of a Traditional course gets Traditional", async () => {
		const cs = await course("cs", "traditional");
		expect(await effectiveProfile(testDb.db, await student(cs))).toBe("traditional");
	});

	test.skipIf(skip)("a student of an Agentic course gets Agentic", async () => {
		const cs = await course("cs", "agentic");
		expect(await effectiveProfile(testDb.db, await student(cs))).toBe("agentic");
	});

	test.skipIf(skip)("the fullest profile among several courses wins", async () => {
		const plain = await course("plain", "traditional");
		const rich = await course("rich", "agentic");
		const other = await course("other", "traditional");
		expect(await effectiveProfile(testDb.db, await student(plain, rich))).toBe(
			"agentic",
		);
		expect(await effectiveProfile(testDb.db, await student(plain, other))).toBe(
			"traditional",
		);
	});

	test.skipIf(skip)(
		"only student memberships count: teaching an Agentic course does not lift a student seat",
		async () => {
			const taught = await course("taught", "agentic");
			const studied = await course("studied", "traditional");
			const id = await insertTestLtiUser(testDb.db);
			await insertTestLtiMembership(testDb.db, id, {
				contextId: taught.contextId,
				role: "instructor",
			});
			await insertTestLtiMembership(testDb.db, id, { contextId: studied.contextId });
			expect(await effectiveProfile(testDb.db, { id, role: "student" })).toBe(
				"traditional",
			);
		},
	);

	test.skipIf(skip)(
		"an instructor or administrator always gets Agentic, even with a student seat",
		async () => {
			const cs = await course("cs", "traditional");
			for (const role of ["instructor", "administrator"] as const) {
				const id = await insertTestUser(testDb.db, { role });
				await insertTestLtiMembership(testDb.db, id, { contextId: cs.contextId });
				expect(await effectiveProfile(testDb.db, { id, role })).toBe("agentic");
			}
		},
	);
});

describe("setCourseProfile", () => {
	test.skipIf(skip)("changes the profile and audits from and to", async () => {
		const cs = await course("cs", "agentic");
		const actor = await insertTestUser(testDb.db, { role: "administrator" });
		const result = await setCourseProfile(testDb.db, {
			courseId: cs.id,
			profile: "traditional",
			actorUserId: actor,
		});
		expect(result).toEqual({ id: cs.id, profile: "traditional" });

		const stored = await testDb.db
			.selectFrom("lti_contexts")
			.select("profile")
			.where("id", "=", cs.id)
			.executeTakeFirstOrThrow();
		expect(stored.profile).toBe("traditional");

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "course.profile_changed")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actor: `user:${actor}`,
			target: cs.id,
			result: "ok",
			metadata: { from: "agentic", to: "traditional" },
		});
	});

	test.skipIf(skip)(
		"setting the profile it already has writes no audit row",
		async () => {
			const cs = await course("cs", "traditional");
			const actor = await insertTestUser(testDb.db, { role: "administrator" });
			const result = await setCourseProfile(testDb.db, {
				courseId: cs.id,
				profile: "traditional",
				actorUserId: actor,
			});
			expect(result).toEqual({ id: cs.id, profile: "traditional" });
			const rows = await testDb.db
				.selectFrom("audit_events")
				.select("id")
				.where("action", "=", "course.profile_changed")
				.execute();
			expect(rows).toEqual([]);
		},
	);

	test.skipIf(skip)(
		"a course that does not exist is null and writes nothing",
		async () => {
			const actor = await insertTestUser(testDb.db, { role: "administrator" });
			const result = await setCourseProfile(testDb.db, {
				courseId: crypto.randomUUID(),
				profile: "traditional",
				actorUserId: actor,
			});
			expect(result).toBeNull();
			const rows = await testDb.db.selectFrom("audit_events").select("id").execute();
			expect(rows).toEqual([]);
		},
	);

	test.skipIf(skip)(
		"the change rolls back when the audit row cannot be written",
		async () => {
			const cs = await course("cs", "agentic");
			// PostgreSQL text cannot hold a NUL byte, so the audit insert fails.
			await expect(
				setCourseProfile(testDb.db, {
					courseId: cs.id,
					profile: "traditional",
					actorUserId: "bad\u0000actor",
				}),
			).rejects.toThrow();
			const stored = await testDb.db
				.selectFrom("lti_contexts")
				.select("profile")
				.where("id", "=", cs.id)
				.executeTakeFirstOrThrow();
			expect(stored.profile).toBe("agentic");
		},
	);
});
