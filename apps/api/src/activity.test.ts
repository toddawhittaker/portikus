import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ACTIVITY_WRITE_INTERVAL_MS, recordActivity } from "./activity.js";

/** The once-a-minute activity writer behind idle stop (ADR 0032). */

const skip = !hasTestDb();
let testDb: TestDb;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-25T12:00:00.000Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

async function makeWorkspace(): Promise<string> {
	const row = await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: await insertTestUser(testDb.db),
			state: "running",
			label: `ws-${crypto.randomUUID().slice(0, 8)}`,
			idle_stop_at: "2026-09-25T12:05:00.000Z",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function readRow(id: string) {
	return testDb.db
		.selectFrom("workspaces")
		.select(["last_activity_at", "idle_stop_at"])
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

async function setIdleStop(id: string): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({ idle_stop_at: "2026-09-25T13:00:00.000Z" })
		.where("id", "=", id)
		.execute();
}

test.skipIf(skip)(
	"the first activity sets the time and clears Still working",
	async () => {
		const id = await makeWorkspace();
		await recordActivity(testDb.db, id);
		const row = await readRow(id);
		expect(row.last_activity_at?.toISOString()).toBe("2026-09-25T12:00:00.000Z");
		expect(row.idle_stop_at).toBeNull();
	},
);

test.skipIf(skip)(
	"activity inside the minute writes nothing; after it, it writes",
	async () => {
		const id = await makeWorkspace();
		await recordActivity(testDb.db, id);

		vi.setSystemTime(Date.now() + ACTIVITY_WRITE_INTERVAL_MS - 1);
		await setIdleStop(id);
		await recordActivity(testDb.db, id);
		let row = await readRow(id);
		expect(row.last_activity_at?.toISOString()).toBe("2026-09-25T12:00:00.000Z");
		expect(row.idle_stop_at).not.toBeNull();

		vi.setSystemTime(Date.now() + 1);
		await recordActivity(testDb.db, id);
		row = await readRow(id);
		expect(row.last_activity_at?.toISOString()).toBe("2026-09-25T12:01:00.000Z");
		expect(row.idle_stop_at).toBeNull();
	},
);

test.skipIf(skip)("each workspace has its own minute", async () => {
	const first = await makeWorkspace();
	const second = await makeWorkspace();
	await recordActivity(testDb.db, first);
	await recordActivity(testDb.db, second);
	expect((await readRow(second)).last_activity_at).not.toBeNull();
	expect((await readRow(second)).idle_stop_at).toBeNull();
});

test.skipIf(skip)("two activities at once make one write", async () => {
	const id = await makeWorkspace();
	const spy = vi.spyOn(testDb.db, "updateTable");
	try {
		await Promise.all([recordActivity(testDb.db, id), recordActivity(testDb.db, id)]);
		expect(spy).toHaveBeenCalledTimes(1);
	} finally {
		spy.mockRestore();
	}
});
