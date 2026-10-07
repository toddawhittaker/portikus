import {
	MAX_KEPT_NOTIFICATIONS_PER_USER,
	MAX_NOTIFICATIONS_PER_USER,
} from "@portikus/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	isUniqueViolation,
	notifyAdministrators,
	recordAudit,
	recordAuditReturningId,
	recordNotification,
} from "./index.js";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "./testing.js";

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

describe("recordAuditReturningId and notifications", () => {
	let t: TestDb;

	beforeAll(async () => {
		if (hasTestDb()) t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	test.skipIf(!hasTestDb())("returns the id of the row it wrote", async () => {
		const id = await recordAuditReturningId(t.db, {
			actor: "system",
			target: "x",
			action: "test.audit_returning",
			result: "ok",
		});
		const row = await t.db
			.selectFrom("audit_events")
			.select("action")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(row.action).toBe("test.audit_returning");
	});

	test.skipIf(!hasTestDb())(
		"recordNotification keeps only a user's newest rows (ADR 0033)",
		async () => {
			const userId = await insertTestUser(t.db);
			for (let i = 0; i <= MAX_NOTIFICATIONS_PER_USER; i++) {
				await recordNotification(t.db, userId, {
					tone: "neutral",
					title: `n${i}`,
					body: "b",
				});
			}
			const rows = await t.db
				.selectFrom("notifications")
				.select("title")
				.where("user_id", "=", userId)
				.execute();
			expect(rows).toHaveLength(MAX_NOTIFICATIONS_PER_USER);
			expect(rows.map((r) => r.title)).not.toContain("n0");
		},
	);

	test.skipIf(!hasTestDb())(
		"recordNotification keeps only a user's newest kept notices",
		async () => {
			const userId = await insertTestUser(t.db);
			await recordNotification(t.db, userId, {
				tone: "neutral",
				title: "plain",
				body: "b",
			});
			for (let i = 0; i <= MAX_KEPT_NOTIFICATIONS_PER_USER; i++) {
				await recordNotification(
					t.db,
					userId,
					{ tone: "warning", title: `k${i}`, body: "b" },
					{ kept: true },
				);
			}
			const rows = await t.db
				.selectFrom("notifications")
				.select(["title", "kept"])
				.where("user_id", "=", userId)
				.execute();
			const kept = rows.filter((r) => r.kept).map((r) => r.title);
			expect(kept).toHaveLength(MAX_KEPT_NOTIFICATIONS_PER_USER);
			expect(kept).not.toContain("k0");
			expect(rows.map((r) => r.title)).toContain("plain");
		},
	);

	test.skipIf(!hasTestDb())(
		"notifyAdministrators reaches enabled administrators only",
		async () => {
			const admin = await insertTestUser(t.db, { role: "administrator" });
			const disabled = await insertTestUser(t.db, {
				role: "administrator",
				disabled_at: new Date().toISOString(),
			});
			const student = await insertTestUser(t.db);
			await notifyAdministrators(t.db, { tone: "warning", title: "t", body: "b" });
			const rows = await t.db
				.selectFrom("notifications")
				.select("user_id")
				.where("user_id", "in", [admin, disabled, student])
				.execute();
			expect(rows.map((r) => r.user_id)).toEqual([admin]);
		},
	);
});
