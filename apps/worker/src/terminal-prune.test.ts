import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ENDED_TERMINAL_MAX_AGE_DAYS, pruneEndedTerminals } from "./terminal-prune.js";

// SPEC.md 9.7: ended terminal rows go after 30 days; open rows stay.
const skip = !hasTestDb();
let tdb: TestDb;
const now = new Date("2026-10-02T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
});

test.skipIf(skip)(
	"deletes rows ended over 30 days ago and keeps the rest",
	async () => {
		expect(ENDED_TERMINAL_MAX_AGE_DAYS).toBe(30);
		const owner = await insertTestUser(tdb.db);
		const ws = await tdb.db
			.insertInto("workspaces")
			.values({
				label: "prune",
				owner_user_id: owner,
				incus_instance_name: "ws-prune",
				state: "stopped",
				desired_state: "stopped",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const row = (name: string, endedDaysAgo: number | null, position: number) => ({
			id: crypto.randomUUID(),
			workspace_id: ws.id,
			name,
			cwd: "/home/student",
			position,
			ended_at:
				endedDaysAgo === null
					? null
					: new Date(now.getTime() - endedDaysAgo * DAY).toISOString(),
		});
		await tdb.db
			.insertInto("terminals")
			.values([row("old", 31, 0), row("recent", 29, 1), row("open", null, 2)])
			.execute();

		expect(await pruneEndedTerminals(tdb.db, now)).toBe(1);
		const left = await tdb.db
			.selectFrom("terminals")
			.select("name")
			.orderBy("name")
			.execute();
		expect(left.map((r) => r.name)).toEqual(["open", "recent"]);
	},
);
