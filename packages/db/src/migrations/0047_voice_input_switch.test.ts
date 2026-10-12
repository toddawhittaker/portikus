import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";

/** Voice input stays on for a site until an administrator turns it off (SPEC.md section 25.10). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0047 tests.");
}

describe.skipIf(!hasTestDb())("migration 0047_voice_input_switch", () => {
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

	test("a new settings row has voice input on", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		const row = await t.db
			.selectFrom("settings")
			.select("voice_input_enabled")
			.executeTakeFirstOrThrow();
		expect(row.voice_input_enabled).toBe(true);
	});
});
