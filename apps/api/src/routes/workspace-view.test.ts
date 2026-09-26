import type { ApiConfig } from "@portikus/config";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { toWorkspace } from "./workspace-view.js";

const skip = !hasTestDb();
let tdb: TestDb;

// toWorkspace reads only the quota sizes from the config.
const config = {
	WORKSPACE_HOME_SIZE_GIB: 25,
	WORKSPACE_DOCKER_SIZE_GIB: 20,
	WORKSPACE_RECOVERY_SIZE_GIB: 10,
} as ApiConfig;

const at = "2026-09-26T10:00:00.000Z";
const throttle = {
	at,
	averagePercent: 97.5,
	thresholdPercent: 80,
	windowMinutes: 30,
	sharePercent: 25,
	allowance: "100ms/100ms",
};
const flag = { at, averagePercent: 93.2, thresholdPercent: 90, windowMinutes: 30 };

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
	await tdb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600 })
		.execute();
});

async function workspaceRow(values: Record<string, unknown>) {
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `ws-view-${Math.random().toString(16).slice(2, 10)}`,
			owner_user_id: await insertTestUser(tdb.db),
			state: "running",
			desired_state: "running",
			...values,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return row as Record<string, unknown>;
}

test.skipIf(skip)(
	"a throttle shows when it lifts, never the average or the allowance",
	async () => {
		const row = await workspaceRow({ cpu_throttle: JSON.stringify(throttle) });
		const view = await toWorkspace(tdb.db, row, 0, config);
		expect(view.cpuThrottle).toEqual({
			at,
			thresholdPercent: 80,
			windowMinutes: 30,
			sharePercent: 25,
			idleLiftMinutes: 5,
			idleLiftPercent: 10,
		});
	},
);

test.skipIf(skip)(
	"the lift facts follow the settings, and are null when off",
	async () => {
		const row = await workspaceRow({ cpu_throttle: JSON.stringify(throttle) });
		await tdb.db
			.updateTable("settings")
			.set({ cpu_idle_lift_minutes: 12, cpu_idle_lift_percent: 3 })
			.execute();
		expect((await toWorkspace(tdb.db, row, 0, config)).cpuThrottle).toMatchObject({
			idleLiftMinutes: 12,
			idleLiftPercent: 3,
		});
		await tdb.db.updateTable("settings").set({ cpu_idle_lift_percent: 0 }).execute();
		expect((await toWorkspace(tdb.db, row, 0, config)).cpuThrottle).toMatchObject({
			idleLiftMinutes: null,
			idleLiftPercent: null,
		});
	},
);

test.skipIf(skip)("the memory flag reaches the owner's view", async () => {
	const row = await workspaceRow({ memory_flag: JSON.stringify(flag) });
	const view = await toWorkspace(tdb.db, row, 0, config);
	expect(view.memoryFlag).toEqual(flag);
	expect(view.cpuThrottle).toBeNull();
});

test.skipIf(skip)("with neither set, both are null", async () => {
	const row = await workspaceRow({});
	const view = await toWorkspace(tdb.db, row, 0, config);
	expect(view.cpuThrottle).toBeNull();
	expect(view.memoryFlag).toBeNull();
});
