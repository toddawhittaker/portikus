import { MAX_NOTIFICATIONS_PER_USER } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { NOTIFICATION_MAX_AGE_DAYS, pruneNotifications } from "./notifications.js";

// SPEC.md section 8.5: keep each user's newest 200, none older than 90 days.
const skip = !hasTestDb();
let tdb: TestDb;
const now = new Date("2026-09-25T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
});

async function insert(userId: string, title: string, at: Date): Promise<void> {
	await tdb.db
		.insertInto("notifications")
		.values({
			user_id: userId,
			tone: "neutral",
			title,
			body: "",
			created_at: at.toISOString(),
		})
		.execute();
}

async function titles(userId: string): Promise<string[]> {
	const rows = await tdb.db
		.selectFrom("notifications")
		.select("title")
		.where("user_id", "=", userId)
		.orderBy("created_at", "desc")
		.execute();
	return rows.map((r) => r.title);
}

test.skipIf(skip)("deletes rows older than 90 days and keeps newer ones", async () => {
	const user = await insertTestUser(tdb.db);
	await insert(
		user,
		"too old",
		new Date(now.getTime() - (NOTIFICATION_MAX_AGE_DAYS + 1) * DAY),
	);
	await insert(
		user,
		"recent",
		new Date(now.getTime() - (NOTIFICATION_MAX_AGE_DAYS - 1) * DAY),
	);
	expect(await pruneNotifications(tdb.db, now)).toBe(1);
	expect(await titles(user)).toEqual(["recent"]);
});

test.skipIf(skip)("keeps only each user's newest 200", async () => {
	const alice = await insertTestUser(tdb.db);
	const bob = await insertTestUser(tdb.db);
	const count = MAX_NOTIFICATIONS_PER_USER + 5;
	await tdb.db
		.insertInto("notifications")
		.values(
			Array.from({ length: count }, (_, i) => ({
				user_id: alice,
				tone: "neutral",
				title: `a${i}`,
				body: "",
				created_at: new Date(now.getTime() - (count - i) * 1000).toISOString(),
			})),
		)
		.execute();
	await insert(bob, "bob's only", new Date(now.getTime() - DAY));

	expect(await pruneNotifications(tdb.db, now)).toBe(5);
	const left = await titles(alice);
	expect(left).toHaveLength(MAX_NOTIFICATIONS_PER_USER);
	expect(left[0]).toBe(`a${count - 1}`);
	expect(left).not.toContain("a4");
	expect(left).toContain("a5");
	expect(await titles(bob)).toEqual(["bob's only"]);
});
