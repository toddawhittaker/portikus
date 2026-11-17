import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0067_weekly_digest.js";

/** The settings row records when the weekly digest last went out (SPEC.md section 20.4). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0067 tests.");
}

describe.skipIf(!hasTestDb())("migration 0067_weekly_digest", () => {
	let t: TestDb;
	const up = () => stepUp(t.db as unknown as Kysely<unknown>);
	const down = () => stepDown(t.db as unknown as Kysely<unknown>);

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});

	test("no digest has gone out until one is recorded", async () => {
		await t.truncate();
		await down();
		try {
			await t.db
				.insertInto("settings")
				.values({ id: 1, shutdown_grace_seconds: 30 })
				.execute();
		} finally {
			await up();
		}
		const row = await t.db
			.selectFrom("settings")
			.select("digest_sent_at")
			.executeTakeFirstOrThrow();
		expect(row.digest_sent_at).toBeNull();
		const at = "2026-11-17T08:00:00.000Z";
		await t.db.updateTable("settings").set({ digest_sent_at: at }).execute();
		const after = await t.db
			.selectFrom("settings")
			.select("digest_sent_at")
			.executeTakeFirstOrThrow();
		expect(after.digest_sent_at?.toISOString()).toBe(at);
	});

	test("down drops the column", async () => {
		await down();
		try {
			await expect(
				sql`select digest_sent_at from settings`.execute(t.db),
			).rejects.toThrow(/does not exist/);
		} finally {
			await up();
		}
	});
});
