import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";

/** Audit rows record how a request arrived, and an older row has neither field (SPEC.md section 24.11). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0059 tests.");
}

describe.skipIf(!hasTestDb())("migration 0059_audit_arrival", () => {
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

	test("a row without the new fields leaves them null", async () => {
		const row = await t.db
			.insertInto("audit_events")
			.values({ actor: "user:1", target: "t", action: "a", result: "ok" })
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(row.via).toBeNull();
		expect(row.api_key_id).toBeNull();
	});

	test("via takes session or api_key only, and the key id has no foreign key", async () => {
		const keyId = "00000000-0000-4000-8000-000000000001";
		await sql`insert into audit_events (actor, target, action, result, via, api_key_id)
			values ('user:1', 't', 'a', 'ok', 'api_key', ${keyId})`.execute(t.db);
		await sql`insert into audit_events (actor, target, action, result, via)
			values ('user:1', 't', 'a', 'ok', 'session')`.execute(t.db);
		await expect(
			sql`insert into audit_events (actor, target, action, result, via)
				values ('user:1', 't', 'a', 'ok', 'cli')`.execute(t.db),
		).rejects.toThrow(/check/);
	});
});
