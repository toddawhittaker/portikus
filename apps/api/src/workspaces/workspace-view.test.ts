import type { ApiConfig } from "@portikus/config";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	loadWorkspaceSettings,
	toWorkspace,
	workspaceView,
	workspaceViews,
} from "./workspace-view.js";

const skip = !hasTestDb();
let tdb: TestDb;

// The views read only the quota sizes and the presence TTL from the config.
const config = {
	WORKSPACE_HOME_SIZE_GIB: 25,
	WORKSPACE_DOCKER_SIZE_GIB: 20,
	WORKSPACE_RECOVERY_SIZE_GIB: 10,
	PRESENCE_TTL_SECONDS: 60,
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
	return row;
}

test.skipIf(skip)(
	"a throttle shows when it lifts, never the average or the allowance",
	async () => {
		const row = await workspaceRow({ cpu_throttle: JSON.stringify(throttle) });
		const view = await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db));
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
		expect(
			(await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db)))
				.cpuThrottle,
		).toMatchObject({
			idleLiftMinutes: 12,
			idleLiftPercent: 3,
		});
		await tdb.db.updateTable("settings").set({ cpu_idle_lift_percent: 0 }).execute();
		expect(
			(await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db)))
				.cpuThrottle,
		).toMatchObject({
			idleLiftMinutes: null,
			idleLiftPercent: null,
		});
	},
);

test.skipIf(skip)("a small share lowers the quiet percent to half of it", async () => {
	const row = await workspaceRow({
		cpu_throttle: JSON.stringify({ ...throttle, sharePercent: 5 }),
	});
	expect(
		(await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db)))
			.cpuThrottle,
	).toMatchObject({
		idleLiftPercent: 2,
	});
});

test.skipIf(skip)(
	"a held throttle tells the owner why a restart keeps it (SPEC.md §19.4)",
	async () => {
		const row = await workspaceRow({
			cpu_throttle: JSON.stringify({ ...throttle, held: { count: 3, hours: 24 } }),
		});
		const view = await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db));
		expect(view.cpuThrottle?.held).toEqual({ count: 3, hours: 24 });
		expect(view.cpuThrottle).not.toHaveProperty("allowance");
	},
);

test.skipIf(skip)("the memory flag reaches the owner's view", async () => {
	const row = await workspaceRow({ memory_flag: JSON.stringify(flag) });
	const view = await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db));
	expect(view.memoryFlag).toEqual(flag);
	expect(view.cpuThrottle).toBeNull();
});

test.skipIf(skip)("with neither set, both are null", async () => {
	const row = await workspaceRow({});
	const view = await toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db));
	expect(view.cpuThrottle).toBeNull();
	expect(view.memoryFlag).toBeNull();
});

test.skipIf(skip)(
	"the list view counts each workspace's live connections, as the single view does (SPEC.md §6.4)",
	async () => {
		const busy = await workspaceRow({});
		const idle = await workspaceRow({});
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		await tdb.db
			.insertInto("workspace_connections")
			.values([
				{ workspace_id: busy.id },
				{ workspace_id: busy.id },
				{ workspace_id: busy.id, last_seen_at: stale },
				{ workspace_id: idle.id, last_seen_at: stale },
			])
			.execute();
		const views = await workspaceViews(tdb.db, config, [busy, idle]);
		expect(views.map((view) => view.activeConnections)).toEqual([2, 0]);
		expect(views).toEqual([
			await workspaceView(tdb.db, config, busy),
			await workspaceView(tdb.db, config, idle),
		]);
	},
);

test.skipIf(skip)(
	"state is verified only while the controller answered within two minutes (SPEC.md §18.3)",
	async () => {
		const row = await workspaceRow({});
		const now = new Date("2026-10-02T12:00:00.000Z");
		const verifiedAt = async (checked: Date | null) => {
			await tdb.db
				.updateTable("settings")
				.set({ controller_checked_at: checked?.toISOString() ?? null })
				.where("id", "=", 1)
				.execute();
			return toWorkspace(row, 0, config, await loadWorkspaceSettings(tdb.db), now)
				.stateVerified;
		};
		expect(await verifiedAt(new Date(now.getTime() - 119_000))).toBe(true);
		expect(await verifiedAt(new Date(now.getTime() - 121_000))).toBe(false);
		expect(await verifiedAt(null)).toBe(false);
		// A check in the future means the clock was stepped back.
		expect(await verifiedAt(new Date(now.getTime() + 1_000))).toBe(false);
		expect(await verifiedAt(now)).toBe(true);
		expect(toWorkspace(row, 0, config, undefined, now).stateVerified).toBe(false);
	},
);
