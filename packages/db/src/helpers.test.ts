import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isUniqueViolation, recordAudit } from "./index.js";
import { createTestDb, hasTestDb, type TestDb } from "./testing.js";

describe("isUniqueViolation", () => {
	const violation = (constraint?: string) =>
		Object.assign(new Error("duplicate key"), { code: "23505", constraint });

	test("matches code 23505, and the constraint when one is named", () => {
		expect(isUniqueViolation(violation("users_email_key"))).toBe(true);
		expect(isUniqueViolation(violation("users_email_key"), "users_email_key")).toBe(
			true,
		);
		expect(isUniqueViolation(violation("other_key"), "users_email_key")).toBe(false);
		expect(isUniqueViolation(violation(), "users_email_key")).toBe(false);
		expect(isUniqueViolation({ code: "23505" })).toBe(true);
	});

	test("is false for other errors, null and non-objects", () => {
		expect(isUniqueViolation(Object.assign(new Error("x"), { code: "23503" }))).toBe(
			false,
		);
		expect(isUniqueViolation(new Error("23505"))).toBe(false);
		expect(isUniqueViolation(null)).toBe(false);
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation("23505")).toBe(false);
	});
});

describe("recordAudit", () => {
	let t: TestDb;

	beforeAll(async () => {
		if (hasTestDb()) t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	test.skipIf(!hasTestDb())(
		"writes the row with metadata as JSON, or null without it",
		async () => {
			await recordAudit(t.db, {
				actor: "user:a",
				target: "workspace:w",
				action: "test.audit_one",
				result: "ok",
				metadata: { reason: "idle", n: 2 },
			});
			await recordAudit(t.db, {
				actor: "system",
				target: "workspace:w",
				action: "test.audit_two",
				result: "failed",
			});
			const rows = await t.db
				.selectFrom("audit_events")
				.select(["actor", "target", "action", "result", "metadata", "at"])
				.where("action", "in", ["test.audit_one", "test.audit_two"])
				.orderBy("id")
				.execute();
			expect(rows.map(({ at: _at, ...rest }) => rest)).toEqual([
				{
					actor: "user:a",
					target: "workspace:w",
					action: "test.audit_one",
					result: "ok",
					metadata: { reason: "idle", n: 2 },
				},
				{
					actor: "system",
					target: "workspace:w",
					action: "test.audit_two",
					result: "failed",
					metadata: null,
				},
			]);
			expect(rows[0]?.at).toBeInstanceOf(Date);
		},
	);

	test.skipIf(!hasTestDb())(
		"writes inside a transaction and rolls back with it",
		async () => {
			const rollback = new Error("rollback");
			await expect(
				t.db.transaction().execute(async (trx) => {
					await recordAudit(trx, {
						actor: "system",
						target: "x",
						action: "test.audit_rolled_back",
						result: "ok",
						metadata: {},
					});
					throw rollback;
				}),
			).rejects.toBe(rollback);
			await t.db.transaction().execute(async (trx) => {
				await recordAudit(trx, {
					actor: "system",
					target: "x",
					action: "test.audit_committed",
					result: "ok",
					metadata: {},
				});
			});
			const rows = await t.db
				.selectFrom("audit_events")
				.select(["action", "metadata"])
				.where("action", "in", ["test.audit_rolled_back", "test.audit_committed"])
				.execute();
			expect(rows).toEqual([{ action: "test.audit_committed", metadata: {} }]);
		},
	);
});
