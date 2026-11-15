import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0057_coding_agents_auto_update.js";

/** The nightly coding-agents update is off until an administrator turns it on (SPEC.md section 22.6). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0057 tests.");
}

describe.skipIf(!hasTestDb())("migration 0057_coding_agents_auto_update", () => {
	let t: TestDb;
	const up = () => stepUp(t.db as unknown as Kysely<unknown>);
	const down = () => stepDown(t.db as unknown as Kysely<unknown>);

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	async function flag() {
		const row = await t.db
			.selectFrom("settings")
			.select("coding_agents_auto_update")
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
		return row.coding_agents_auto_update;
	}

	test("a site from before the migration has it off", async () => {
		await down();
		try {
			await t.db
				.insertInto("settings")
				.values({ id: 1, shutdown_grace_seconds: 30 })
				.execute();
		} finally {
			await up();
		}
		expect(await flag()).toBe(false);
	});

	test("it can be turned on", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 30, coding_agents_auto_update: true })
			.execute();
		expect(await flag()).toBe(true);
	});
});
