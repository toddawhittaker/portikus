import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0052_terminal_kind.js";

/** A terminal row is a shell or a chat; rows from before chat tabs are shells (SPEC.md section 10.8). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0052 tests.");
}

describe.skipIf(!hasTestDb())("migration 0052_terminal_kind", () => {
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

	async function workspace(): Promise<string> {
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: "ws-0052",
				owner_user_id: await insertTestUser(t.db),
				state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return ws.id;
	}

	test("a row written before the migration reads back as a terminal", async () => {
		const workspaceId = await workspace();
		await down();
		try {
			await sql`insert into terminals (workspace_id, name, cwd)
				values (${workspaceId}, 'shell', '/home/student')`.execute(t.db);
		} finally {
			await up();
		}
		const row = await t.db
			.selectFrom("terminals")
			.select("kind")
			.executeTakeFirstOrThrow();
		expect(row.kind).toBe("terminal");
	});

	test("a chat row is accepted", async () => {
		const row = await t.db
			.insertInto("terminals")
			.values({
				workspace_id: await workspace(),
				name: "chat",
				cwd: "/home/student",
				kind: "chat",
			})
			.returning("kind")
			.executeTakeFirstOrThrow();
		expect(row.kind).toBe("chat");
	});

	test("any other kind is refused", async () => {
		const err = await t.db
			.insertInto("terminals")
			.values({
				workspace_id: await workspace(),
				name: "x",
				cwd: "/home/student",
				kind: "other",
			})
			.execute()
			.catch((e: { code?: string }) => e);
		expect((err as { code?: string }).code).toBe("23514");
	});
});
