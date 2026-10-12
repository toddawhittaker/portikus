import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestUser,
	type TestDb,
} from "../testing.js";

/** One open live help session per workspace, and a layout version per project (ADR 0063). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0048 tests.");
}

describe.skipIf(!hasTestDb())("migration 0048_live_help", () => {
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

	async function seed() {
		const studentId = await insertTestUser(t.db);
		const helperId = await insertTestUser(t.db, { role: "instructor" });
		const courseId = await insertTestLtiMembership(t.db, helperId, {
			role: "instructor",
		});
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: `ws-${Math.random().toString(36).slice(2, 10)}`,
				owner_user_id: studentId,
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const project = await t.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "demo",
				name: "Demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returning(["id", "layout_version"])
			.executeTakeFirstOrThrow();
		return {
			workspaceId: ws.id,
			projectId: project.id,
			layoutVersion: project.layout_version,
			helperId,
			courseId,
		};
	}

	function session(s: Awaited<ReturnType<typeof seed>>, endsInMs = 3_600_000) {
		return {
			workspace_id: s.workspaceId,
			project_id: s.projectId,
			helper_user_id: s.helperId,
			course_id: s.courseId,
			ends_at: new Date(Date.now() + endsInMs).toISOString(),
		};
	}

	test("a new project starts at layout version 0", async () => {
		const s = await seed();
		expect(s.layoutVersion).toBe(0);
	});

	test("a session starts with typing off", async () => {
		const s = await seed();
		const row = await t.db
			.insertInto("live_help_sessions")
			.values(session(s))
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(row.typing).toBe(false);
		expect(row.ended_at).toBeNull();
	});

	test("a workspace holds at most one open session", async () => {
		const s = await seed();
		const first = await t.db
			.insertInto("live_help_sessions")
			.values(session(s))
			.returning("id")
			.executeTakeFirstOrThrow();
		await expect(
			t.db.insertInto("live_help_sessions").values(session(s)).execute(),
		).rejects.toThrow(/live_help_one_open/);
		await t.db
			.updateTable("live_help_sessions")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", first.id)
			.execute();
		await t.db.insertInto("live_help_sessions").values(session(s)).execute();
	});

	test("a session must end after it starts", async () => {
		const s = await seed();
		await expect(
			t.db.insertInto("live_help_sessions").values(session(s, -1000)).execute(),
		).rejects.toThrow(/live_help_sessions_ends_after_start/);
	});

	test("a deleted project takes its session with it", async () => {
		const s = await seed();
		await t.db.insertInto("live_help_sessions").values(session(s)).execute();
		await t.db.deleteFrom("projects").where("id", "=", s.projectId).execute();
		const left = await t.db.selectFrom("live_help_sessions").select("id").execute();
		expect(left).toEqual([]);
	});
});
