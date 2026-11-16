import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0060_audit_via_assistant.js";

/** An audit row can say it came through the assistant, and nothing else new (SPEC.md section 24.11). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0060 tests.");
}

describe.skipIf(!hasTestDb())("migration 0060_audit_via_assistant", () => {
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

	const insertVia = (via: string) =>
		sql`insert into audit_events (actor, target, action, result, via)
			values ('user:1', 't', 'a', 'ok', ${via})`.execute(t.db);

	test("via takes session, api_key and assistant, and refuses anything else", async () => {
		await insertVia("session");
		await insertVia("api_key");
		await insertVia("assistant");
		await expect(insertVia("cli")).rejects.toThrow(/audit_events_via_check/);
	});

	test("down turns assistant rows into session and refuses assistant again; up restores it", async () => {
		await insertVia("assistant");
		await down();
		const rows = await t.db.selectFrom("audit_events").select("via").execute();
		expect(rows.map((r) => r.via)).toEqual(["session"]);
		await expect(insertVia("assistant")).rejects.toThrow(/audit_events_via_check/);
		await insertVia("api_key");
		await up();
		await insertVia("assistant");
	});
});
