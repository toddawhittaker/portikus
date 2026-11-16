import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0061_ai_settings.js";

/** The built-in AI is one row, off by default, with the default limits (SPEC.md section 20.4). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0061 tests.");
}

describe.skipIf(!hasTestDb())("migration 0061_ai_settings", () => {
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
		// The settings row is not a per-test fixture: put it back as the migration left it.
		await sql`update ai_settings set enabled = false, provider_kind = null, base_url = null,
			model = null, key_sealed = null, key_hint = null, notice_version = null,
			notice_accepted_by = null, notice_accepted_at = null`.execute(t.db);
		await t.truncate();
	});

	test("the migration inserts one row that is off, empty and has the default limits", async () => {
		const rows = await t.db.selectFrom("ai_settings").selectAll().execute();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.id).toBe(1);
		expect(row?.enabled).toBe(false);
		expect(row?.provider_kind).toBeNull();
		expect(row?.key_sealed).toBeNull();
		expect(row?.key_hint).toBeNull();
		expect(row?.monthly_token_cap).toBe("5000000");
		expect(row?.conversation_token_budget).toBe(200000);
		expect(row?.price_sources).toEqual([]);
		expect(row?.notice_version).toBeNull();
	});

	test("only one row can exist", async () => {
		await expect(
			sql`insert into ai_settings (id) values (2)`.execute(t.db),
		).rejects.toThrow(/check/);
		await expect(
			sql`insert into ai_settings (id) values (1)`.execute(t.db),
		).rejects.toThrow(/unique|duplicate/);
	});

	test("provider kind, limits and the key and its hint are checked", async () => {
		const set = (fragment: ReturnType<typeof sql>) =>
			sql`update ai_settings set ${fragment}`.execute(t.db);
		await set(sql`provider_kind = 'anthropic'`);
		await set(sql`provider_kind = 'openai-compatible'`);
		await expect(set(sql`provider_kind = 'gemini'`)).rejects.toThrow(/check/);
		await expect(set(sql`monthly_token_cap = -1`)).rejects.toThrow(/check/);
		await expect(set(sql`conversation_token_budget = 0`)).rejects.toThrow(/check/);
		await expect(set(sql`key_sealed = 'sealed'`)).rejects.toThrow(/check/);
		await expect(set(sql`key_hint = 'abcd'`)).rejects.toThrow(/check/);
		await expect(set(sql`key_sealed = 'sealed', key_hint = 'abcde'`)).rejects.toThrow(
			/check/,
		);
		await set(sql`key_sealed = 'sealed', key_hint = 'abcd'`);
	});

	test("deleting the person who accepted the notice or saved the settings clears the reference", async () => {
		const id = await insertTestUser(t.db);
		await sql`update ai_settings set notice_version = 1, notice_accepted_by = ${id},
			notice_accepted_at = now(), updated_by = ${id}`.execute(t.db);
		await t.db.deleteFrom("users").where("id", "=", id).execute();
		const row = await t.db
			.selectFrom("ai_settings")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.notice_version).toBe(1);
		expect(row.notice_accepted_by).toBeNull();
		expect(row.updated_by).toBeNull();
	});

	test("down drops the table and up makes the row again", async () => {
		await down();
		await expect(sql`select 1 from ai_settings`.execute(t.db)).rejects.toThrow(
			/does not exist/,
		);
		await up();
		const rows = await t.db.selectFrom("ai_settings").select("id").execute();
		expect(rows).toHaveLength(1);
	});
});
