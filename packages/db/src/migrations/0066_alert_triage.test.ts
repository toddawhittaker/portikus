import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0066_alert_triage.js";

/** Alerts can carry a model's explanation, behind two switches that start off (SPEC.md section 20.4). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0066 tests.");
}

describe.skipIf(!hasTestDb())("migration 0066_alert_triage", () => {
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
		await t.db.deleteFrom("ai_usage_days").execute();
		await t.truncate();
	});

	async function settings() {
		return t.db
			.selectFrom("ai_settings")
			.select(["triage_enabled", "triage_daily_limit", "triage_forward"])
			.executeTakeFirstOrThrow();
	}

	function usage(purpose: string) {
		return t.db
			.insertInto("ai_usage_days")
			.values({
				day: "2026-11-17",
				user_id: null,
				purpose: purpose as "triage",
				model: "m",
			})
			.execute();
	}

	test("the settings row from before the migration has triage off, a limit of 5 and no forwarding", async () => {
		await down();
		await up();
		expect(await settings()).toEqual({
			triage_enabled: false,
			triage_daily_limit: 5,
			triage_forward: false,
		});
	});

	test("the daily limit stays between 0 and 100", async () => {
		for (const ok of [0, 100]) {
			await sql`update ai_settings set triage_daily_limit = ${ok}`.execute(t.db);
		}
		for (const bad of [-1, 101]) {
			await expect(
				sql`update ai_settings set triage_daily_limit = ${bad}`.execute(t.db),
			).rejects.toThrow(/check/);
		}
		await sql`update ai_settings set triage_daily_limit = 5`.execute(t.db);
	});

	test("a notification starts with no explanation and keeps one once written", async () => {
		const user = await insertTestUser(t.db);
		const row = await t.db
			.insertInto("notifications")
			.values({ user_id: user, tone: "warning", title: "Disk", body: "" })
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(row.triage).toBeNull();
		expect(row.triaged_at).toBeNull();
		const at = new Date().toISOString();
		await t.db
			.updateTable("notifications")
			.set({ triage: "Backups grew.", triaged_at: at })
			.execute();
		await expect(
			t.db.updateTable("notifications").set({ triage: "" }).execute(),
		).rejects.toThrow(/check/);
		await expect(
			t.db
				.updateTable("notifications")
				.set({ triage: "x".repeat(2001) })
				.execute(),
		).rejects.toThrow(/check/);
	});

	test("usage may be counted under triage, and nothing unknown", async () => {
		await usage("triage");
		await expect(usage("digest")).rejects.toThrow(/check/);
	});

	test("down removes triage usage and the columns, and up restores them", async () => {
		await usage("triage");
		await usage("pricing");
		await down();
		try {
			const left = await sql<{
				purpose: string;
			}>`select purpose from ai_usage_days`.execute(t.db);
			expect(left.rows.map((r) => r.purpose)).toEqual(["pricing"]);
			await expect(usage("triage")).rejects.toThrow(/check/);
			await expect(sql`select triage from notifications`.execute(t.db)).rejects.toThrow(
				/does not exist/,
			);
			await expect(
				sql`select triage_enabled from ai_settings`.execute(t.db),
			).rejects.toThrow(/does not exist/);
		} finally {
			await up();
		}
	});
});
