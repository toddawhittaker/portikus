import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";

/** Account email starts off, and a token row holds only a unique hash (SPEC.md section 5.3). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0049 tests.");
}

describe.skipIf(!hasTestDb())("migration 0049_account_email", () => {
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

	async function user(): Promise<string> {
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: "urn:portikus:dex",
				oidc_subject: "email-token-test",
				email: "a@example.test",
				display_name: "A",
				role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	test("a new settings row has account email off", async () => {
		await t.db
			.insertInto("settings")
			.values({ id: 1, shutdown_grace_seconds: 600 })
			.execute();
		const row = await t.db
			.selectFrom("settings")
			.select("account_email_enabled")
			.executeTakeFirstOrThrow();
		expect(row.account_email_enabled).toBe(false);
	});

	test("token hashes are unique, the purpose is checked, and removing the user removes its tokens", async () => {
		const id = await user();
		const values = {
			user_id: id,
			purpose: "reset" as const,
			token_hash: "h1",
			expires_at: new Date(Date.now() + 60_000),
		};
		await t.db.insertInto("account_email_tokens").values(values).execute();
		await expect(
			t.db.insertInto("account_email_tokens").values(values).execute(),
		).rejects.toThrow(/unique/);
		await expect(
			sql`insert into account_email_tokens (user_id, purpose, token_hash, expires_at)
				values (${id}, 'other', 'h2', now())`.execute(t.db),
		).rejects.toThrow(/check/);
		await t.db.deleteFrom("users").where("id", "=", id).execute();
		const left = await t.db.selectFrom("account_email_tokens").select("id").execute();
		expect(left).toEqual([]);
	});
});
