import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { pruneExpiredCounters } from "./counter-prune.js";

// ADR 0053: a sign-in count goes once its window has ended; a live one stays.
const skip = !hasTestDb();
let tdb: TestDb;
const now = new Date("2026-10-06T12:00:00Z");
const MINUTE = 60_000;

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

test.skipIf(skip)("deletes only counts whose window has ended", async () => {
	const row = (key: string, endsInMinutes: number) => ({
		scope: "password",
		key,
		window_started_at: new Date(now.getTime() + (endsInMinutes - 10) * MINUTE),
		expires_at: new Date(now.getTime() + endsInMinutes * MINUTE),
		count: 3,
	});
	await tdb.db
		.insertInto("signin_counters")
		.values([row("ended", -1), row("ends-now", 0), row("live", 1)])
		.execute();

	expect(await pruneExpiredCounters(tdb.db, now)).toBe(2);
	const left = await tdb.db.selectFrom("signin_counters").select("key").execute();
	expect(left.map((r) => r.key)).toEqual(["live"]);
});
