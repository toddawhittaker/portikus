import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { shareAudience, sharesCourseWith, teachesCourse } from "./membership.js";

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

/** Two courses: Ivy teaches CS 101, where Sam studies; Olga teaches CS 202, where Pat studies. */
async function seed() {
	const db = testDb.db;
	const ivy = await insertTestUser(db, { role: "instructor" });
	const sam = await insertTestUser(db);
	const olga = await insertTestUser(db, { role: "instructor" });
	const pat = await insertTestUser(db);
	const cs101 = await insertTestLtiMembership(db, ivy, {
		contextId: "cs101",
		role: "instructor",
	});
	await insertTestLtiMembership(db, sam, { contextId: "cs101" });
	const cs202 = await insertTestLtiMembership(db, olga, {
		contextId: "cs202",
		role: "instructor",
	});
	await insertTestLtiMembership(db, pat, { contextId: "cs202" });
	return { ivy, sam, olga, pat, cs101, cs202 };
}

describe("teachesCourse", () => {
	test.skipIf(skip)("is true only for an instructor of that course", async () => {
		const { ivy, sam, olga, cs101 } = await seed();
		const db = testDb.db;
		expect(await teachesCourse(db, { userId: ivy, courseId: cs101 })).toBe(true);
		// A student of the course, and an instructor of another course, do not teach it.
		expect(await teachesCourse(db, { userId: sam, courseId: cs101 })).toBe(false);
		expect(await teachesCourse(db, { userId: olga, courseId: cs101 })).toBe(false);
		expect(
			await teachesCourse(db, {
				userId: ivy,
				courseId: "00000000-0000-4000-8000-000000000000",
			}),
		).toBe(false);
	});

	test.skipIf(skip)(
		"ignores the account role; only the membership counts",
		async () => {
			const { cs101 } = await seed();
			const admin = await insertTestUser(testDb.db, { role: "administrator" });
			expect(await teachesCourse(testDb.db, { userId: admin, courseId: cs101 })).toBe(
				false,
			);
		},
	);
});

describe("sharesCourseWith", () => {
	test.skipIf(skip)(
		"is true for a member of a course the instructor teaches",
		async () => {
			const { ivy, sam, cs101 } = await seed();
			expect(
				await sharesCourseWith(testDb.db, {
					instructorId: ivy,
					memberId: sam,
					courseId: cs101,
				}),
			).toBe(true);
		},
	);

	test.skipIf(skip)("is false across courses", async () => {
		const { ivy, sam, olga, pat, cs101, cs202 } = await seed();
		const db = testDb.db;
		// Pat is not in Ivy's course.
		expect(
			await sharesCourseWith(db, { instructorId: ivy, memberId: pat, courseId: cs101 }),
		).toBe(false);
		// Olga teaches CS 202, which Sam is not in.
		expect(
			await sharesCourseWith(db, {
				instructorId: olga,
				memberId: sam,
				courseId: cs202,
			}),
		).toBe(false);
		// Naming the member's own course does not help an instructor who does not teach it.
		expect(
			await sharesCourseWith(db, {
				instructorId: olga,
				memberId: sam,
				courseId: cs101,
			}),
		).toBe(false);
		// Ivy teaches CS 101, but the course named must be that one.
		expect(
			await sharesCourseWith(db, { instructorId: ivy, memberId: sam, courseId: cs202 }),
		).toBe(false);
	});

	test.skipIf(skip)("is false for a student looking at a classmate", async () => {
		const { sam, cs101 } = await seed();
		const classmate = await insertTestUser(testDb.db);
		await insertTestLtiMembership(testDb.db, classmate, { contextId: "cs101" });
		expect(
			await sharesCourseWith(testDb.db, {
				instructorId: sam,
				memberId: classmate,
				courseId: cs101,
			}),
		).toBe(false);
	});

	test.skipIf(skip)("is false once the member's membership is removed", async () => {
		const { ivy, sam, cs101 } = await seed();
		await testDb.db
			.deleteFrom("lti_memberships")
			.where("context_id", "=", cs101)
			.where("user_id", "=", sam)
			.execute();
		expect(
			await sharesCourseWith(testDb.db, {
				instructorId: ivy,
				memberId: sam,
				courseId: cs101,
			}),
		).toBe(false);
	});
});

describe("shareAudience", () => {
	test.skipIf(skip)(
		"lists each of the user's courses with its other instructors, by name",
		async () => {
			const db = testDb.db;
			const sam = await insertTestUser(db, { display_name: "Sam" });
			const ivy = await insertTestUser(db, { display_name: "Ivy", role: "instructor" });
			const ian = await insertTestUser(db, { display_name: "Ian", role: "instructor" });
			const olga = await insertTestUser(db, {
				display_name: "Olga",
				role: "instructor",
			});
			const cleo = await insertTestUser(db, { display_name: "Cleo" });
			const memberships = [
				[sam, "cs101", "CS 101", "student"],
				[ivy, "cs101", "CS 101", "instructor"],
				[ian, "cs101", "CS 101", "instructor"],
				[cleo, "cs101", "CS 101", "student"],
				// Sam teaches this one, and is not their own audience.
				[sam, "lab", "Algorithms Lab", "instructor"],
				[olga, "other", "CS 999", "instructor"],
			] as const;
			for (const [user, contextId, title, role] of memberships) {
				await insertTestLtiMembership(db, user, { contextId, title, role });
			}
			expect(await shareAudience(db, sam)).toEqual([
				{
					courseId: expect.any(String),
					courseTitle: "Algorithms Lab",
					instructors: [],
				},
				{
					courseId: expect.any(String),
					courseTitle: "CS 101",
					instructors: ["Ian", "Ivy"],
				},
			]);
			expect(await shareAudience(db, olga)).toEqual([
				{ courseId: expect.any(String), courseTitle: "CS 999", instructors: [] },
			]);
			expect(await shareAudience(db, await insertTestUser(db))).toEqual([]);
		},
	);
});
