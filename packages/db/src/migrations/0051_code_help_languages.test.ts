import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0051_code_help_languages.js";

/** Code help is a set of languages; the old switch carries over both ways (SPEC.md section 13.6, ADR 0067). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0051 tests.");
}

describe.skipIf(!hasTestDb())("migration 0051_code_help_languages", () => {
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

	async function languages(): Promise<string[]> {
		const row = await t.db
			.selectFrom("settings")
			.select("code_help_languages")
			.executeTakeFirstOrThrow();
		return row.code_help_languages;
	}

	/** Step to the old shape, store the old switch, then run `up` again. */
	async function carryOver(enabled: boolean): Promise<string[]> {
		await down();
		await sql`insert into settings (id, shutdown_grace_seconds, code_help_enabled)
			values (1, 600, ${enabled})`.execute(t.db);
		await up();
		return languages();
	}

	test("a new settings row has both languages", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		expect(await languages()).toEqual(["python", "typescript"]);
	});

	test("a site with code help off carries over as no languages", async () => {
		expect(await carryOver(false)).toEqual([]);
	});

	test("a site with code help on carries over as both languages", async () => {
		expect(await carryOver(true)).toEqual(["python", "typescript"]);
	});

	test("down restores the switch: any language is on, none is off", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		await t.db
			.updateTable("settings")
			.set({ code_help_languages: ["python"] })
			.execute();
		await down();
		try {
			const some = await sql<{ code_help_enabled: boolean }>`
				select code_help_enabled from settings`.execute(t.db);
			expect(some.rows[0]?.code_help_enabled).toBe(true);
		} finally {
			await up();
		}

		await t.db.updateTable("settings").set({ code_help_languages: [] }).execute();
		await down();
		try {
			const none = await sql<{ code_help_enabled: boolean }>`
				select code_help_enabled from settings`.execute(t.db);
			expect(none.rows[0]?.code_help_enabled).toBe(false);
		} finally {
			await up();
		}
	});
});
