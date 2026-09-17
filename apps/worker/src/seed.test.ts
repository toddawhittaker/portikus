import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { seedSettings } from "./index.js";

const skip = !hasTestDb();
let tdb: TestDb;

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

async function grace(): Promise<number> {
	const row = await tdb.db
		.selectFrom("settings")
		.select("shutdown_grace_seconds")
		.where("id", "=", 1)
		.executeTakeFirstOrThrow();
	return row.shutdown_grace_seconds;
}

test.skipIf(skip)("the first seed inserts the row", async () => {
	expect(await seedSettings(tdb.db, 600)).toBe(true);
	expect(await grace()).toBe(600);
});

test.skipIf(skip)("a later seed leaves an existing row alone", async () => {
	await seedSettings(tdb.db, 600);
	await tdb.db
		.updateTable("settings")
		.set({ shutdown_grace_seconds: 0 })
		.where("id", "=", 1)
		.execute();

	expect(await seedSettings(tdb.db, 600)).toBe(false);
	expect(await grace()).toBe(0);
});
