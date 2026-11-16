import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown } from "./0063_ai_usage_days.js";

/** AI tokens are counted once per day, person, purpose and model, with a missing person counted as one (SPEC.md section 20.4). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0063 tests.");
}

describe.skipIf(!hasTestDb())("migration 0063_ai_usage_days", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		// Cleared first: deleting users would otherwise turn leftover rows into duplicate null-person rows.
		await t.db.deleteFrom("ai_usage_days").execute();
		await t.truncate();
	});

	function usage(userId: string | null, extra: Record<string, unknown> = {}) {
		return t.db
			.insertInto("ai_usage_days")
			.values({
				day: "2026-11-15",
				user_id: userId,
				purpose: "assistant",
				model: "claude-opus-5-5",
				...extra,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
	}

	test("counts start at zero", async () => {
		const row = await usage(await insertTestUser(t.db));
		expect(row.input_tokens).toBe("0");
		expect(row.output_tokens).toBe("0");
		expect(row.cache_read_tokens).toBe("0");
		expect(row.cache_write_tokens).toBe("0");
	});

	test("one row per day, person, purpose and model", async () => {
		const a = await insertTestUser(t.db);
		const b = await insertTestUser(t.db);
		await usage(a);
		await usage(b);
		await usage(a, { day: "2026-11-16" });
		await usage(a, { purpose: "pricing" });
		await usage(a, { model: "gpt-6.1" });
		await expect(usage(a)).rejects.toThrow(/duplicate|unique/);
	});

	test("rows with no person are one row too, because nulls are not distinct", async () => {
		await usage(null);
		await expect(usage(null)).rejects.toThrow(/duplicate|unique/);
		await usage(null, { purpose: "pricing" });
	});

	test("deleting a person keeps their usage with the person cleared", async () => {
		const id = await insertTestUser(t.db);
		await usage(id, { input_tokens: 10 });
		await t.db.deleteFrom("users").where("id", "=", id).execute();
		const rows = await t.db.selectFrom("ai_usage_days").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.user_id).toBeNull();
		expect(rows[0]?.input_tokens).toBe("10");
	});

	test("purpose, model and counts are checked", async () => {
		const id = await insertTestUser(t.db);
		await expect(usage(id, { purpose: "chat" })).rejects.toThrow(/check/);
		await expect(usage(id, { model: "" })).rejects.toThrow(/check/);
		await expect(usage(id, { output_tokens: -1 })).rejects.toThrow(/check/);
		await expect(usage(id, { cache_write_tokens: -1 })).rejects.toThrow(/check/);
	});

	test("down drops the table", async () => {
		await stepDown(t.db as unknown as Kysely<unknown>);
		await expect(sql`select 1 from ai_usage_days`.execute(t.db)).rejects.toThrow(
			/does not exist/,
		);
	});
});
