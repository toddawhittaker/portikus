import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0054_alert_state.js";

/** The settings row remembers which administrator alerts are raised (SPEC.md sections 24.4 and 24.13). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0054 tests.");
}

describe.skipIf(!hasTestDb())("migration 0054_alert_state", () => {
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

	async function flags() {
		return t.db
			.selectFrom("settings")
			.select(["alert_reboot_raised", "alert_signin_raised", "alert_root_fs_raised"])
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
	}

	test("a settings row from before the migration has no alert raised", async () => {
		await down();
		try {
			await t.db
				.insertInto("settings")
				.values({ id: 1, shutdown_grace_seconds: 30 })
				.execute();
		} finally {
			await up();
		}
		expect(await flags()).toEqual({
			alert_reboot_raised: false,
			alert_signin_raised: false,
			alert_root_fs_raised: false,
		});
	});

	test("each flag is stored on its own", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 30, alert_signin_raised: true })
			.execute();
		expect(await flags()).toEqual({
			alert_reboot_raised: false,
			alert_signin_raised: true,
			alert_root_fs_raised: false,
		});
	});
});
