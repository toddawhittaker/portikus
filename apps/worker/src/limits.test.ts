import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { createLimitsSync, LIMITS_RETRY_SECONDS, startLimitsSync } from "./limits.js";

const skip = !hasTestDb();
let tdb: TestDb;
let counter = 0;

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

type Limits = { cpu?: number; memoryMiB?: number; processes?: number };

async function insertWorkspace(opts: {
	config: Limits | null;
	applied: Limits | null;
	state?: string;
}): Promise<{ id: string; instance: string }> {
	counter++;
	const instance = `ws-limits-${counter}`;
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `ws-limits-${counter}`,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: instance,
			state: opts.state ?? "running",
			desired_state: "running",
			image_version: "abc123",
			limits_config: opts.config ? JSON.stringify(opts.config) : null,
			limits_applied: opts.applied ? JSON.stringify(opts.applied) : null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, instance };
}

async function applied(id: string) {
	const row = await tdb.db
		.selectFrom("workspaces")
		.select("limits_applied")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return row.limits_applied;
}

async function audits(id: string) {
	return tdb.db
		.selectFrom("audit_events")
		.select(["actor", "action", "result", "metadata"])
		.where("target", "=", id)
		.orderBy("id")
		.execute();
}

function build(now: () => Date = () => new Date()) {
	const controller = new FakeControllerClient();
	const { logger, lines } = collectingLogger();
	const tick = createLimitsSync({ db: tdb.db, controller, logger, now });
	const sets = () => controller.calls.filter((c) => c.method === "setLimits");
	return { controller, lines, tick, sets };
}

test.skipIf(skip)(
	"new limits are set on the running instance once, recorded and audited",
	async () => {
		const ws = await insertWorkspace({
			config: { cpu: 2, memoryMiB: 4096 },
			applied: null,
		});
		const { tick, sets } = build();

		await tick();
		await tick();

		// A missing key is sent as null, so the instance's own value goes and the profile applies.
		expect(sets().map((c) => c.args)).toEqual([
			[ws.instance, { cpu: 2, memoryMiB: 4096, processes: null }],
		]);
		expect(await applied(ws.id)).toEqual({ cpu: 2, memoryMiB: 4096 });
		expect(await audits(ws.id)).toEqual([
			{
				actor: "worker",
				action: "workspace.limits_applied",
				result: "ok",
				metadata: { from: {}, to: { cpu: 2, memoryMiB: 4096 } },
			},
		]);
	},
);

test.skipIf(skip)("clearing every limit removes them from the instance", async () => {
	const ws = await insertWorkspace({ config: null, applied: { processes: 2000 } });
	const { tick, sets } = build();
	await tick();
	expect(sets().map((c) => c.args)).toEqual([
		[ws.instance, { cpu: null, memoryMiB: null, processes: null }],
	]);
	expect(await applied(ws.id)).toEqual({});
	expect((await audits(ws.id))[0]?.metadata).toEqual({
		from: { processes: 2000 },
		to: {},
	});
});

test.skipIf(skip)("a stopped workspace gets its limits too", async () => {
	const ws = await insertWorkspace({
		config: { processes: 1000 },
		applied: null,
		state: "stopped",
	});
	const { tick, sets } = build();
	await tick();
	expect(sets()).toHaveLength(1);
	expect(await applied(ws.id)).toEqual({ processes: 1000 });
});

test.skipIf(skip)(
	"matching, unset, provisioning and errored rows are left alone",
	async () => {
		await insertWorkspace({ config: { cpu: 2 }, applied: { cpu: 2 } });
		await insertWorkspace({ config: null, applied: null });
		await insertWorkspace({ config: {}, applied: null });
		await insertWorkspace({ config: { cpu: 2 }, applied: null, state: "provisioning" });
		await insertWorkspace({ config: { cpu: 2 }, applied: null, state: "error" });
		const { tick, sets } = build();
		await tick();
		expect(sets()).toEqual([]);
	},
);

test.skipIf(skip)("a row with no instance name is left alone", async () => {
	const ws = await insertWorkspace({ config: { cpu: 2 }, applied: null });
	await tdb.db
		.updateTable("workspaces")
		.set({ incus_instance_name: null })
		.where("id", "=", ws.id)
		.execute();
	const { tick, sets } = build();
	await tick();
	expect(sets()).toEqual([]);
});

test.skipIf(skip)(
	"a failed write is audited once and retried after a rest",
	async () => {
		const ws = await insertWorkspace({ config: { cpu: 99 as number }, applied: null });
		// Out of the stored bounds, so it is skipped rather than sent.
		const bad = build();
		await bad.tick();
		expect(bad.sets()).toEqual([]);

		await tdb.db
			.updateTable("workspaces")
			.set({ limits_config: JSON.stringify({ cpu: 8 }) })
			.where("id", "=", ws.id)
			.execute();
		let clock = new Date("2026-09-27T10:00:00Z");
		const { controller, tick, sets, lines } = build(() => clock);
		controller.setLimitsError = new ControllerClientError(
			"BAD_REQUEST",
			"More CPUs than the host has",
		);

		await tick();
		await tick();
		expect(sets()).toHaveLength(1);
		expect(await applied(ws.id)).toBeNull();
		expect(await audits(ws.id)).toEqual([
			{
				actor: "worker",
				action: "workspace.limits_apply_failed",
				result: "failed",
				metadata: { errorCode: "BAD_REQUEST", to: { cpu: 8 } },
			},
		]);
		expect(lines.some((line) => line.msg === "limits apply failed")).toBe(true);

		clock = new Date(clock.getTime() + LIMITS_RETRY_SECONDS * 1000);
		await tick();
		expect(sets()).toHaveLength(2);
		// Still failing: no second audit row for the same wanted limits.
		expect(await audits(ws.id)).toHaveLength(1);

		controller.setLimitsError = null;
		clock = new Date(clock.getTime() + LIMITS_RETRY_SECONDS * 1000);
		await tick();
		expect(await applied(ws.id)).toEqual({ cpu: 8 });
		expect((await audits(ws.id)).map((a) => a.action)).toEqual([
			"workspace.limits_apply_failed",
			"workspace.limits_applied",
		]);
	},
);

test.skipIf(skip)("a new wanted value is tried at once after a failure", async () => {
	const ws = await insertWorkspace({ config: { cpu: 8 }, applied: null });
	const { controller, tick, sets } = build();
	controller.setLimitsError = new Error("boom");
	await tick();
	expect((await audits(ws.id))[0]?.metadata).toEqual({
		errorCode: "OPERATION_FAILED",
		to: { cpu: 8 },
	});
	controller.setLimitsError = null;
	await tdb.db
		.updateTable("workspaces")
		.set({ limits_config: JSON.stringify({ cpu: 4 }) })
		.where("id", "=", ws.id)
		.execute();
	await tick();
	expect(sets()).toHaveLength(2);
	expect(await applied(ws.id)).toEqual({ cpu: 4 });
});

test.skipIf(skip)("a change made during the write is not marked applied", async () => {
	const ws = await insertWorkspace({ config: { cpu: 2 }, applied: null });
	const { controller, tick } = build();
	const original = controller.setLimits.bind(controller);
	controller.setLimits = async (name, req) => {
		await original(name, req);
		await tdb.db
			.updateTable("workspaces")
			.set({ limits_config: JSON.stringify({ cpu: 3 }) })
			.where("id", "=", ws.id)
			.execute();
	};
	await tick();
	expect(await applied(ws.id)).toBeNull();
	expect(await audits(ws.id)).toEqual([]);
});

test.skipIf(skip)("a database failure is logged and the next tick runs", async () => {
	const { logger, lines } = collectingLogger();
	const broken = {
		selectFrom: () => {
			throw new Error("db down");
		},
	} as unknown as TestDb["db"];
	const tick = createLimitsSync({
		db: broken,
		controller: new FakeControllerClient(),
		logger,
	});
	await tick();
	await tick();
	expect(lines.filter((line) => line.msg === "limits sync failed")).toHaveLength(2);
});

test.skipIf(skip)("the timer runs a tick at once and stops", async () => {
	vi.useFakeTimers();
	try {
		const { logger } = collectingLogger();
		const controller = new FakeControllerClient();
		const stop = startLimitsSync({ db: tdb.db, controller, logger });
		stop();
	} finally {
		vi.useRealTimers();
	}
});
