import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";

/** A key row holds only a unique hash, a checked scope, and may never expire (SPEC.md section 24.13). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0058 tests.");
}

describe.skipIf(!hasTestDb())("migration 0058_api_keys", () => {
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

	function key(userId: string, hash: string) {
		return {
			user_id: userId,
			name: "laptop",
			token_hash: hash,
			display_prefix: "portikus_abcd",
		};
	}

	test("a new key is read-only, never expires, and has not been used, revoked or reminded", async () => {
		const id = await insertTestUser(t.db, { role: "instructor" });
		const row = await t.db
			.insertInto("api_keys")
			.values(key(id, "h1"))
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(row.scope).toBe("read");
		expect(row.expires_at).toBeNull();
		expect(row.period_days).toBeNull();
		expect(row.last_used_at).toBeNull();
		expect(row.revoked_at).toBeNull();
		expect(row.revoked_by).toBeNull();
		expect(row.expiry_reminded_for).toBeNull();
	});

	test("hashes are unique, and scope, name and period are checked", async () => {
		const id = await insertTestUser(t.db);
		await t.db.insertInto("api_keys").values(key(id, "h1")).execute();
		await expect(
			t.db.insertInto("api_keys").values(key(id, "h1")).execute(),
		).rejects.toThrow(/unique/);
		await expect(
			sql`insert into api_keys (user_id, name, token_hash, display_prefix, scope)
				values (${id}, 'n', 'h2', 'p', 'root')`.execute(t.db),
		).rejects.toThrow(/check/);
		await expect(
			t.db
				.insertInto("api_keys")
				.values({ ...key(id, "h3"), name: "" })
				.execute(),
		).rejects.toThrow(/check/);
		await expect(
			t.db
				.insertInto("api_keys")
				.values({ ...key(id, "h4"), name: "x".repeat(101) })
				.execute(),
		).rejects.toThrow(/check/);
		await expect(
			t.db
				.insertInto("api_keys")
				.values({ ...key(id, "h5"), period_days: 0 })
				.execute(),
		).rejects.toThrow(/check/);
	});

	test("removing the owner removes their keys; removing the revoker keeps the key", async () => {
		const owner = await insertTestUser(t.db);
		const admin = await insertTestUser(t.db, { role: "administrator" });
		await t.db
			.insertInto("api_keys")
			.values({ ...key(owner, "h1"), revoked_by: admin, revoked_at: new Date() })
			.execute();
		await t.db.deleteFrom("users").where("id", "=", admin).execute();
		const kept = await t.db
			.selectFrom("api_keys")
			.select(["revoked_by", "revoked_at"])
			.execute();
		expect(kept).toHaveLength(1);
		expect(kept[0]?.revoked_by).toBeNull();
		expect(kept[0]?.revoked_at).not.toBeNull();
		await t.db.deleteFrom("users").where("id", "=", owner).execute();
		expect(await t.db.selectFrom("api_keys").select("id").execute()).toEqual([]);
	});
});
