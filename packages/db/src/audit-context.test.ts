import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { auditArrival, recordAudit, recordAuditReturningId } from "./index.js";
import { createTestDb, hasTestDb, type TestDb } from "./testing.js";

/** A request's arrival reaches its audit rows without any call site passing it (SPEC.md section 24.11). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping audit context tests.");
}

describe.skipIf(!hasTestDb())("audit arrival", () => {
	let t: TestDb;
	const KEY = "00000000-0000-4000-8000-000000000002";
	const event = { actor: "user:1", target: "t", action: "a", result: "ok" };

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	async function rows() {
		return t.db
			.selectFrom("audit_events")
			.select(["action", "via", "api_key_id"])
			.orderBy("id")
			.execute();
	}

	test("a row written inside a run carries both fields", async () => {
		await auditArrival.run({ via: "api_key", apiKeyId: KEY }, () =>
			recordAudit(t.db, event),
		);
		expect(await rows()).toEqual([{ action: "a", via: "api_key", api_key_id: KEY }]);
	});

	test("a session arrival has no key id", async () => {
		await auditArrival.run({ via: "session", apiKeyId: null }, () =>
			recordAudit(t.db, event),
		);
		expect(await rows()).toEqual([{ action: "a", via: "session", api_key_id: null }]);
	});

	test("a row written outside a run carries neither", async () => {
		await recordAudit(t.db, event);
		expect(await rows()).toEqual([{ action: "a", via: null, api_key_id: null }]);
	});

	test("the arrival reaches rows written later in the same run, including inside a transaction", async () => {
		await auditArrival.run({ via: "api_key", apiKeyId: KEY }, async () => {
			await Promise.resolve();
			await t.db.transaction().execute(async (trx) => {
				await recordAuditReturningId(trx, { ...event, action: "b" });
			});
		});
		await recordAudit(t.db, { ...event, action: "c" });
		expect(await rows()).toEqual([
			{ action: "b", via: "api_key", api_key_id: KEY },
			{ action: "c", via: null, api_key_id: null },
		]);
	});
});
