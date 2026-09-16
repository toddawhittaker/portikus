import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "./testing.js";

if (!hasTestDb()) {
	console.log(
		"TEST_DATABASE_URL is not set — skipping database tests. " +
			"See docs/WORKFLOW.md for how to run a local Postgres.",
	);
}

describe("database migrations and schema", () => {
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

	test.skipIf(!hasTestDb())("migrate twice is idempotent", async () => {
		const { migrateToLatest } = await import("./migrate.js");
		const applied = await migrateToLatest(t.db);
		expect(applied).toEqual([]);
	});

	test.skipIf(!hasTestDb())("workspaces table accepts a valid row", async () => {
		const userId = await insertTestUser(t.db);
		const row = await t.db
			.insertInto("workspaces")
			.values({
				owner_user_id: userId,
				state: "provisioning",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(row.owner_user_id).toBe(userId);
		expect(row.state).toBe("provisioning");
		expect(row.desired_state).toBe("stopped");
		expect(row.id).toBeTruthy();
		expect(row.created_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())("workspaces rejects duplicate owner_user_id", async () => {
		const userId = await insertTestUser(t.db);
		await t.db
			.insertInto("workspaces")
			.values({ owner_user_id: userId, state: "provisioning" })
			.execute();

		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: userId,
					state: "provisioning",
				})
				.execute(),
		).rejects.toThrow(/unique|duplicate/i);
	});

	test.skipIf(!hasTestDb())("workspaces rejects an invalid state", async () => {
		const userId = await insertTestUser(t.db);
		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: userId,
					state: "flying",
				})
				.execute(),
		).rejects.toThrow(/check|violates/i);
	});

	test.skipIf(!hasTestDb())("workspace_connections accepts a valid row", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({ owner_user_id: await insertTestUser(t.db), state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();

		const conn = await t.db
			.insertInto("workspace_connections")
			.values({ workspace_id: ws.id })
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(conn.workspace_id).toBe(ws.id);
		expect(conn.connected_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())(
		"cascade delete removes connections when workspace is deleted",
		async () => {
			const ws = await t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: await insertTestUser(t.db),
					state: "running",
				})
				.returning("id")
				.executeTakeFirstOrThrow();

			await t.db
				.insertInto("workspace_connections")
				.values({ workspace_id: ws.id })
				.execute();

			await t.db.deleteFrom("workspaces").where("id", "=", ws.id).execute();

			const remaining = await t.db
				.selectFrom("workspace_connections")
				.where("workspace_id", "=", ws.id)
				.selectAll()
				.execute();

			expect(remaining).toHaveLength(0);
		},
	);

	test.skipIf(!hasTestDb())("audit_events table accepts a valid row", async () => {
		const row = await t.db
			.insertInto("audit_events")
			.values({
				actor: "system",
				target: "ws-abc123",
				action: "workspace.provision_requested",
				result: "success",
				metadata: JSON.stringify({ foo: "bar" }),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(Number(row.id)).toBeGreaterThan(0);
		expect(row.action).toBe("workspace.provision_requested");
		expect(row.at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())(
		"users rejects a duplicate issuer and subject pair",
		async () => {
			await insertTestUser(t.db, { oidc_subject: "subject-dup" });

			const err = await t.db
				.insertInto("users")
				.values({
					oidc_issuer: "https://test.invalid",
					oidc_subject: "subject-dup",
					display_name: "Test User",
					role: "student",
				})
				.execute()
				.catch((e: { code?: string }) => e);

			expect((err as { code?: string }).code).toBe("23505");
		},
	);

	test.skipIf(!hasTestDb())("deleting a user cascades to its sessions", async () => {
		const userId = await insertTestUser(t.db);
		await t.db
			.insertInto("sessions")
			.values({
				id: "session-cascade",
				user_id: userId,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		await t.db.deleteFrom("users").where("id", "=", userId).execute();

		const remaining = await t.db
			.selectFrom("sessions")
			.where("user_id", "=", userId)
			.selectAll()
			.execute();
		expect(remaining).toHaveLength(0);
	});

	test.skipIf(!hasTestDb())("workspaces rejects an unknown owner", async () => {
		const err = await t.db
			.insertInto("workspaces")
			.values({
				owner_user_id: "00000000-0000-0000-0000-000000000000",
				state: "provisioning",
			})
			.execute()
			.catch((e: { code?: string }) => e);

		expect((err as { code?: string }).code).toBe("23503");
	});

	test.skipIf(!hasTestDb())("migrations roll back and reapply", async () => {
		const { Migrator } = await import("kysely/migration");
		const { migrations } = await import("./migrations/index.js");
		const rollback = new Error("rollback");

		// Runs inside a transaction that is always rolled back, so the
		// schema other tests share is left untouched.
		await expect(
			t.db.transaction().execute(async (trx) => {
				const migrator = new Migrator({
					db: trx,
					provider: { getMigrations: async () => migrations },
				});
				const down = await migrator.migrateDown();
				expect(down.error).toBeUndefined();
				const down2 = await migrator.migrateDown();
				expect(down2.error).toBeUndefined();
				const up = await migrator.migrateToLatest();
				expect(up.error).toBeUndefined();
				expect(up.results?.map((r) => r.migrationName)).toEqual([
					"0001_workspaces",
					"0002_users_sessions",
				]);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});
});
