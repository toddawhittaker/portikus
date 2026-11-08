import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0053_chat_settings.js";

/** A project keeps the chat picker values its owner last used (SPEC.md section 10.8). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0053 tests.");
}

describe.skipIf(!hasTestDb())("migration 0053_chat_settings", () => {
	let t: TestDb;
	const up = () => stepUp(t.db as unknown as Kysely<unknown>);
	const down = () => stepDown(t.db as unknown as Kysely<unknown>);

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
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: "ws-0053",
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const row = await t.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "p",
				name: "p",
				path: "/home/student/projects/p",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function stored(id: string) {
		const row = await t.db
			.selectFrom("projects")
			.select("chat_settings")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return row.chat_settings;
	}

	test("a project from before the migration has no chat settings", async () => {
		await down();
		let id = "";
		try {
			id = await project();
		} finally {
			await up();
		}
		expect(await stored(id)).toBeNull();
	});

	test("chat settings are stored and read back", async () => {
		const id = await project();
		const value = { model: "opus", effort: "low", mode: "auto" };
		await t.db
			.updateTable("projects")
			.set({ chat_settings: JSON.stringify(value) })
			.where("id", "=", id)
			.execute();
		expect(await stored(id)).toEqual(value);
	});
});
