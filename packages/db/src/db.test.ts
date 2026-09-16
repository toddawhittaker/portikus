import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "./testing.js";

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
		const row = await t.db
			.insertInto("workspaces")
			.values({
				owner_user_id: "user-1",
				state: "provisioning",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(row.owner_user_id).toBe("user-1");
		expect(row.state).toBe("provisioning");
		expect(row.desired_state).toBe("stopped");
		expect(row.id).toBeTruthy();
		expect(row.created_at).toBeInstanceOf(Date);
	});

	test.skipIf(!hasTestDb())("workspaces rejects duplicate owner_user_id", async () => {
		await t.db
			.insertInto("workspaces")
			.values({ owner_user_id: "user-dup", state: "provisioning" })
			.execute();

		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: "user-dup",
					state: "provisioning",
				})
				.execute(),
		).rejects.toThrow(/unique|duplicate/i);
	});

	test.skipIf(!hasTestDb())("workspaces rejects an invalid state", async () => {
		await expect(
			t.db
				.insertInto("workspaces")
				.values({
					owner_user_id: "user-bad-state",
					state: "flying",
				})
				.execute(),
		).rejects.toThrow(/check|violates/i);
	});

	test.skipIf(!hasTestDb())("workspace_connections accepts a valid row", async () => {
		const ws = await t.db
			.insertInto("workspaces")
			.values({ owner_user_id: "user-conn", state: "running" })
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
				.values({ owner_user_id: "user-cascade", state: "running" })
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
});
