import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0055_check_runs.js";

/** Finished check runs are kept per project ("Check result metadata", SPEC.md §25). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0055 tests.");
}

describe.skipIf(!hasTestDb())("migration 0055_check_runs", () => {
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

	async function project(): Promise<string> {
		const owner = await insertTestUser(t.db);
		const ws = await t.db
			.insertInto("workspaces")
			.values({ label: "w", owner_user_id: owner, state: "running" })
			.returning("id")
			.executeTakeFirstOrThrow();
		const row = await t.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "demo",
				name: "Demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	function run(projectId: string, overrides: Record<string, unknown> = {}) {
		return t.db
			.insertInto("check_runs")
			.values({
				project_id: projectId,
				check_id: "test",
				agent_run_id: "1-1",
				state: "passed",
				started_at: "2026-11-14T10:00:00Z",
				ended_at: "2026-11-14T10:00:02Z",
				exit_code: 0,
				output: Buffer.from("ok\n"),
				...overrides,
			})
			.execute();
	}

	test("stores a run and refuses the same agent run twice", async () => {
		const id = await project();
		await run(id);
		await expect(run(id)).rejects.toThrow();
		const rows = await t.db.selectFrom("check_runs").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.output.toString()).toBe("ok\n");
	});

	test("refuses a state that is not a finished one", async () => {
		const id = await project();
		await expect(run(id, { state: "running" })).rejects.toThrow();
	});

	test("refuses output over 64 KiB", async () => {
		const id = await project();
		await run(id, { output: Buffer.alloc(64 * 1024) });
		await expect(
			run(id, { agent_run_id: "1-2", output: Buffer.alloc(64 * 1024 + 1) }),
		).rejects.toThrow();
	});

	test("goes with its project", async () => {
		const id = await project();
		await run(id);
		await t.db.deleteFrom("projects").where("id", "=", id).execute();
		expect(await t.db.selectFrom("check_runs").selectAll().execute()).toEqual([]);
	});

	test("rolls back and forward", async () => {
		const db = t.db as unknown as Kysely<unknown>;
		await stepDown(db);
		await stepUp(db);
		const id = await project();
		await run(id);
	});
});
