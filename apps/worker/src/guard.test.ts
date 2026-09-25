import type { InstanceUsage } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { FakeControllerClient } from "./fake-controller.js";
import { allowanceFor, createGuard, SAMPLE_RETENTION_MINUTES } from "./guard.js";

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

const GiB = 2 ** 30;
const MINUTE_NS = 60e9;
const T0 = new Date("2026-09-25T12:00:00.000Z").getTime();

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

async function insertWorkspace(
	overrides: Record<string, unknown> = {},
): Promise<{ id: string; instance: string }> {
	counter++;
	const instance = `ws-guard-${counter}`;
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: instance,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: instance,
			state: "running",
			desired_state: "running",
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, instance };
}

async function row(id: string) {
	return tdb.db
		.selectFrom("workspaces")
		.select(["cpu_throttle", "memory_flag"])
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

async function audits(id: string) {
	return tdb.db
		.selectFrom("audit_events")
		.select(["actor", "action", "result", "metadata"])
		.where("target", "=", id)
		.orderBy("id")
		.execute();
}

async function sampleCount(id: string): Promise<number> {
	const rows = await tdb.db
		.selectFrom("workspace_usage_samples")
		.select("id")
		.where("workspace_id", "=", id)
		.execute();
	return rows.length;
}

/**
 * A simulated instance on a fixed clock. `busy(minute)` is the fraction of
 * its four CPUs used in that minute; `memory(minute)` the fraction of its
 * memory limit.
 */
function harness(opts: {
	instance: string;
	busy?: (minute: number) => number;
	memory?: (minute: number) => number;
}) {
	const controller = new FakeControllerClient();
	const { logger } = collectingLogger();
	let minute = 0;
	let cpuNs = 0;
	let allowance: string | null = null;
	const busy = opts.busy ?? (() => 0.1);
	const memory = opts.memory ?? (() => 0.1);
	const usage = (): InstanceUsage => ({
		name: opts.instance,
		cpuUsageNs: Math.round(cpuNs),
		cpuLimit: 4,
		memoryBytes: Math.round(memory(minute) * 6 * GiB),
		memoryLimitBytes: 6 * GiB,
		cpuAllowance: allowance,
	});
	const now = () => new Date(T0 + minute * 60_000);
	let tick = createGuard({ db: tdb.db, controller, logger, now });
	const refresh = () => {
		controller.usageResult = [usage()];
	};
	refresh();
	// Record allowance writes the way Incus would, unless the call is set to fail.
	const original = controller.setCpuAllowance.bind(controller);
	controller.setCpuAllowance = async (name, value) => {
		await original(name, value);
		allowance = value;
	};
	return {
		controller,
		now,
		get minute() {
			return minute;
		},
		/** Tick at the current minute. */
		async tick() {
			refresh();
			await tick();
		},
		/** Advance one minute of CPU use, then tick. */
		async step() {
			cpuNs += busy(minute) * 4 * MINUTE_NS;
			minute++;
			refresh();
			await tick();
		},
		async steps(n: number) {
			for (let i = 0; i < n; i++) await this.step();
		},
		/** A new guard over the same database, as after a worker restart. */
		restartWorker() {
			tick = createGuard({ db: tdb.db, controller, logger, now });
		},
		/** The instance restarted: the CPU counter and the allowance reset. */
		restartInstance() {
			cpuNs = 0;
			allowance = null;
		},
		set allowance(value: string | null) {
			allowance = value;
		},
		get allowance() {
			return allowance;
		},
		allowanceCalls() {
			return controller.calls.filter((c) => c.method === "setCpuAllowance");
		},
	};
}

test("the allowance is a time slice of the share of the CPU limit", () => {
	expect(allowanceFor(25, 4)).toBe("100ms/100ms");
	expect(allowanceFor(25, 2)).toBe("50ms/100ms");
	expect(allowanceFor(100, 4)).toBe("400ms/100ms");
	expect(allowanceFor(5, 1)).toBe("5ms/100ms");
});

test.skipIf(skip)(
	"a steady 100% workspace is throttled at the first full window, not before",
	async () => {
		const ws = await insertWorkspace();
		const h = harness({ instance: ws.instance, busy: () => 1 });
		await h.tick();
		await h.steps(29);
		expect((await row(ws.id)).cpu_throttle).toBeNull();
		expect(h.allowanceCalls()).toHaveLength(0);

		await h.step();
		const throttle = (await row(ws.id)).cpu_throttle;
		expect(throttle).toMatchObject({
			averagePercent: 100,
			thresholdPercent: 80,
			windowMinutes: 30,
			sharePercent: 25,
			allowance: "100ms/100ms",
		});
		expect(h.allowanceCalls().map((c) => c.args)).toEqual([
			[ws.instance, "100ms/100ms"],
		]);
		expect(h.allowance).toBe("100ms/100ms");

		// A second tick writes nothing more.
		await h.step();
		expect(h.allowanceCalls()).toHaveLength(1);
		const rows = await audits(ws.id);
		expect(rows).toEqual([
			{
				actor: "worker",
				action: "workspace.cpu_throttled",
				result: "ok",
				metadata: {
					averagePercent: 100,
					thresholdPercent: 80,
					windowMinutes: 30,
					sharePercent: 25,
					allowance: "100ms/100ms",
				},
			},
		]);
	},
);

test.skipIf(skip)("a workspace at 79% is not throttled", async () => {
	const ws = await insertWorkspace();
	const h = harness({ instance: ws.instance, busy: () => 0.79 });
	await h.tick();
	await h.steps(45);
	expect((await row(ws.id)).cpu_throttle).toBeNull();
	expect(h.allowanceCalls()).toHaveLength(0);
});

test.skipIf(skip)(
	"pausing one minute in every 29 does not dodge the average",
	async () => {
		const ws = await insertWorkspace();
		const h = harness({
			instance: ws.instance,
			busy: (minute) => (minute % 29 === 28 ? 0 : 1),
		});
		await h.tick();
		await h.steps(30);
		expect((await row(ws.id)).cpu_throttle).toMatchObject({ allowance: "100ms/100ms" });
	},
);

test.skipIf(skip)("a threshold of 100 never throttles", async () => {
	const ws = await insertWorkspace({
		guard_config: JSON.stringify({ cpuThresholdPercent: 100 }),
	});
	const h = harness({ instance: ws.instance, busy: () => 1 });
	await h.tick();
	await h.steps(35);
	expect((await row(ws.id)).cpu_throttle).toBeNull();
});

test.skipIf(skip)("workspace overrides set the window and the share", async () => {
	const ws = await insertWorkspace({
		guard_config: JSON.stringify({ windowMinutes: 5, throttleSharePercent: 50 }),
	});
	const h = harness({ instance: ws.instance, busy: () => 1 });
	await h.tick();
	await h.steps(4);
	expect((await row(ws.id)).cpu_throttle).toBeNull();
	await h.step();
	expect((await row(ws.id)).cpu_throttle).toMatchObject({
		windowMinutes: 5,
		sharePercent: 50,
		allowance: "200ms/100ms",
	});
});

test.skipIf(skip)("a restart mid-window starts a new window", async () => {
	const ws = await insertWorkspace();
	const h = harness({ instance: ws.instance, busy: () => 1 });
	await h.tick();
	await h.steps(20);
	h.restartInstance();
	await h.steps(20);
	// 40 minutes busy in all, but only 20 since the restart.
	expect((await row(ws.id)).cpu_throttle).toBeNull();
	await h.steps(11);
	expect((await row(ws.id)).cpu_throttle).not.toBeNull();
});

test.skipIf(skip)(
	"a worker restart and a controller that lost the allowance both end with it set",
	async () => {
		const ws = await insertWorkspace();
		const h = harness({ instance: ws.instance, busy: () => 1 });
		await h.tick();
		await h.steps(30);
		expect(h.allowance).toBe("100ms/100ms");

		h.restartWorker();
		h.allowance = null;
		await h.step();
		expect(h.allowance).toBe("100ms/100ms");
		expect(h.allowanceCalls()).toHaveLength(2);
		// Still one throttle audit row.
		expect((await audits(ws.id)).map((a) => a.action)).toEqual([
			"workspace.cpu_throttled",
		]);
	},
);

test.skipIf(skip)("a lift in the database removes the allowance", async () => {
	const ws = await insertWorkspace();
	const h = harness({ instance: ws.instance, busy: () => 1 });
	await h.tick();
	await h.steps(30);
	expect(h.allowance).toBe("100ms/100ms");

	// What the administrator's lift does (ADR 0032).
	await tdb.db
		.updateTable("workspaces")
		.set({ cpu_throttle: null })
		.where("id", "=", ws.id)
		.execute();
	await tdb.db
		.deleteFrom("workspace_usage_samples")
		.where("workspace_id", "=", ws.id)
		.execute();
	await h.step();
	expect(h.allowance).toBeNull();
	expect(h.allowanceCalls().at(-1)?.args).toEqual([ws.instance, null]);
	// A full new window before it can be throttled again.
	await h.steps(29);
	expect((await row(ws.id)).cpu_throttle).toBeNull();
	await h.step();
	expect((await row(ws.id)).cpu_throttle).not.toBeNull();
});

test.skipIf(skip)(
	"an unthrottled workspace carrying an allowance loses it",
	async () => {
		const ws = await insertWorkspace();
		const h = harness({ instance: ws.instance });
		h.allowance = "50ms/100ms";
		await h.tick();
		expect(h.allowance).toBeNull();
	},
);

test.skipIf(skip)("a controller failure is audited once and retried", async () => {
	const ws = await insertWorkspace();
	const h = harness({ instance: ws.instance, busy: () => 1 });
	h.controller.setCpuAllowanceError = FakeControllerClient.error("INCUS_UNAVAILABLE");
	await h.tick();
	await h.steps(33);
	expect((await row(ws.id)).cpu_throttle).not.toBeNull();
	expect(h.allowanceCalls()).toHaveLength(4);
	expect(h.allowance).toBeNull();
	const failed = (await audits(ws.id)).filter(
		(a) => a.action === "workspace.cpu_throttle_failed",
	);
	expect(failed).toEqual([
		{
			actor: "worker",
			action: "workspace.cpu_throttle_failed",
			result: "failed",
			metadata: { errorCode: "INCUS_UNAVAILABLE", allowance: "100ms/100ms" },
		},
	]);

	h.controller.setCpuAllowanceError = null;
	await h.step();
	expect(h.allowance).toBe("100ms/100ms");
});

test.skipIf(skip)("a failed usage read changes nothing", async () => {
	const ws = await insertWorkspace();
	const controller = new FakeControllerClient();
	controller.usageResult = FakeControllerClient.error("INCUS_UNAVAILABLE");
	const { logger } = collectingLogger();
	await createGuard({ db: tdb.db, controller, logger })();
	expect(await sampleCount(ws.id)).toBe(0);
});

test.skipIf(skip)("memory above 90% is flagged; 89% is not", async () => {
	const high = await insertWorkspace();
	const h = harness({ instance: high.instance, memory: () => 0.91 });
	await h.tick();
	await h.steps(13);
	expect((await row(high.id)).memory_flag).toBeNull();
	await h.step();
	expect((await row(high.id)).memory_flag).toMatchObject({
		averagePercent: 91,
		thresholdPercent: 90,
		windowMinutes: 30,
	});
	await h.steps(5);
	expect((await audits(high.id)).map((a) => [a.action, a.metadata])).toEqual([
		[
			"workspace.memory_flagged",
			{ averagePercent: 91, thresholdPercent: 90, windowMinutes: 30 },
		],
	]);
	// Memory is never throttled.
	expect(h.allowanceCalls()).toHaveLength(0);

	const low = await insertWorkspace();
	const l = harness({ instance: low.instance, memory: () => 0.89 });
	await l.tick();
	await l.steps(40);
	expect((await row(low.id)).memory_flag).toBeNull();
});

test.skipIf(skip)(
	"memory is not judged with fewer than half the window's samples",
	async () => {
		const ws = await insertWorkspace();
		const h = harness({ instance: ws.instance, memory: () => 0.99 });
		await h.tick();
		await h.steps(13);
		expect(await sampleCount(ws.id)).toBe(14);
		expect((await row(ws.id)).memory_flag).toBeNull();
	},
);

test.skipIf(skip)(
	"stopped workspaces are not sampled and old samples are pruned",
	async () => {
		const stopped = await insertWorkspace({
			state: "stopped",
			desired_state: "stopped",
		});
		const ws = await insertWorkspace();
		const h = harness({ instance: ws.instance });
		await tdb.db
			.insertInto("workspace_usage_samples")
			.values({
				workspace_id: ws.id,
				observed_at: new Date(
					T0 - (SAMPLE_RETENTION_MINUTES + 1) * 60_000,
				).toISOString(),
				cpu_usage_ns: 0,
				cpu_limit: 4,
				memory_bytes: 0,
				memory_limit_bytes: GiB,
			})
			.execute();
		await h.tick();
		expect(await sampleCount(ws.id)).toBe(1);
		expect(await sampleCount(stopped.id)).toBe(0);
		// The old sample was pruned; the new one is from now.
		const kept = await tdb.db
			.selectFrom("workspace_usage_samples")
			.select("observed_at")
			.where("workspace_id", "=", ws.id)
			.executeTakeFirstOrThrow();
		expect(kept.observed_at.getTime()).toBe(T0);
	},
);
