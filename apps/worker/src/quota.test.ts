import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { createQuotaSync, QUOTA_RETRY_SECONDS } from "./quota.js";

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

type Sizes = { homeGiB: number; dockerGiB: number };

async function insertWorkspace(opts: {
	config: Sizes | null;
	applied: Sizes | null;
	state?: string;
	imageVersion?: string | null;
}): Promise<{ id: string; instance: string }> {
	counter++;
	const instance = `ws-quota-${counter}`;
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `ws-quota-${counter}`,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: instance,
			state: opts.state ?? "running",
			desired_state: "running",
			image_version: opts.imageVersion === undefined ? "abc123" : opts.imageVersion,
			quota_config: opts.config ? JSON.stringify(opts.config) : null,
			quota_applied: opts.applied ? JSON.stringify(opts.applied) : null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, instance };
}

async function applied(id: string) {
	const row = await tdb.db
		.selectFrom("workspaces")
		.select("quota_applied")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return row.quota_applied;
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
	const tick = createQuotaSync({ db: tdb.db, controller, logger, now });
	const grows = () => controller.calls.filter((c) => c.method === "growVolumes");
	return { controller, lines, tick, grows };
}

test.skipIf(skip)("a pending quota is applied once and audited", async () => {
	const ws = await insertWorkspace({
		config: { homeGiB: 30, dockerGiB: 40 },
		applied: { homeGiB: 25, dockerGiB: 20 },
	});
	const { tick, grows } = build();

	await tick();
	await tick();

	expect(grows().map((c) => c.args)).toEqual([
		[ws.instance, { homeGiB: 30, dockerGiB: 40 }],
	]);
	expect(await applied(ws.id)).toEqual({ homeGiB: 30, dockerGiB: 40 });
	expect(await audits(ws.id)).toEqual([
		{
			actor: "worker",
			action: "workspace.quota_applied",
			result: "ok",
			metadata: {
				from: { homeGiB: 25, dockerGiB: 20 },
				to: { homeGiB: 30, dockerGiB: 40 },
			},
		},
	]);
});

test.skipIf(skip)("a stopped workspace is grown too", async () => {
	const ws = await insertWorkspace({
		config: { homeGiB: 30, dockerGiB: 20 },
		applied: { homeGiB: 25, dockerGiB: 20 },
		state: "stopped",
	});
	const { tick, grows } = build();
	await tick();
	expect(grows()).toHaveLength(1);
	expect(await applied(ws.id)).toEqual({ homeGiB: 30, dockerGiB: 20 });
});

test.skipIf(skip)(
	"matching, provisioning, and never-created rows are left alone",
	async () => {
		await insertWorkspace({
			config: { homeGiB: 25, dockerGiB: 20 },
			applied: { homeGiB: 25, dockerGiB: 20 },
		});
		await insertWorkspace({
			config: { homeGiB: 30, dockerGiB: 20 },
			applied: null,
			state: "provisioning",
		});
		await insertWorkspace({
			config: { homeGiB: 30, dockerGiB: 20 },
			applied: null,
			state: "error",
			imageVersion: null,
		});
		await insertWorkspace({ config: null, applied: null, state: "stopped" });
		const { tick, grows } = build();
		await tick();
		expect(grows()).toEqual([]);
	},
);

test.skipIf(skip)(
	"a quota_config that also holds recoveryGiB still grows and records only home and docker",
	async () => {
		const ws = await insertWorkspace({
			config: { homeGiB: 30, dockerGiB: 20, recoveryGiB: 10 } as Sizes,
			applied: { homeGiB: 25, dockerGiB: 20 },
		});
		const { tick, grows } = build();
		await tick();
		await tick();
		expect(grows().map((c) => c.args)).toEqual([
			[ws.instance, { homeGiB: 30, dockerGiB: 20 }],
		]);
		expect(await applied(ws.id)).toEqual({ homeGiB: 30, dockerGiB: 20 });
		expect((await audits(ws.id)).map((a) => a.action)).toEqual([
			"workspace.quota_applied",
		]);
	},
);

test.skipIf(skip)(
	"a row whose home and docker match is left alone even with recoveryGiB set",
	async () => {
		await insertWorkspace({
			config: { homeGiB: 25, dockerGiB: 20, recoveryGiB: 10 } as Sizes,
			applied: { homeGiB: 25, dockerGiB: 20 },
		});
		const { tick, grows } = build();
		await tick();
		expect(grows()).toEqual([]);
	},
);

test.skipIf(skip)(
	"recoveryGiB in both quota_config and quota_applied triggers no grow and no audit",
	async () => {
		const ws = await insertWorkspace({
			config: { homeGiB: 25, dockerGiB: 20, recoveryGiB: 10 } as Sizes,
			applied: { homeGiB: 25, dockerGiB: 20, recoveryGiB: 10 } as Sizes,
		});
		const { tick, grows } = build();
		await tick();
		expect(grows()).toEqual([]);
		expect(await audits(ws.id)).toEqual([]);
	},
);

test.skipIf(skip)(
	"a failed grow is audited once and retried after a rest",
	async () => {
		const ws = await insertWorkspace({
			config: { homeGiB: 30, dockerGiB: 20 },
			applied: { homeGiB: 25, dockerGiB: 20 },
		});
		let now = new Date("2026-09-22T12:00:00Z");
		const { controller, tick, grows, lines } = build(() => now);
		controller.growError = new ControllerClientError("STORAGE_FULL", "pool full");

		await tick();
		await tick();
		expect(grows()).toHaveLength(1);

		now = new Date(now.getTime() + QUOTA_RETRY_SECONDS * 1000);
		await tick();
		expect(grows()).toHaveLength(2);

		expect(await applied(ws.id)).toEqual({ homeGiB: 25, dockerGiB: 20 });
		expect(await audits(ws.id)).toEqual([
			{
				actor: "worker",
				action: "workspace.quota_apply_failed",
				result: "failed",
				metadata: { errorCode: "STORAGE_FULL", to: { homeGiB: 30, dockerGiB: 20 } },
			},
		]);
		expect(lines.filter((l) => l.msg === "quota apply failed")).toHaveLength(2);

		controller.growError = null;
		now = new Date(now.getTime() + QUOTA_RETRY_SECONDS * 1000);
		await tick();
		expect(await applied(ws.id)).toEqual({ homeGiB: 30, dockerGiB: 20 });
		expect((await audits(ws.id)).map((a) => a.action)).toEqual([
			"workspace.quota_apply_failed",
			"workspace.quota_applied",
		]);
	},
);

test.skipIf(skip)(
	"a new wanted size is tried at once even after a failure",
	async () => {
		const ws = await insertWorkspace({
			config: { homeGiB: 30, dockerGiB: 20 },
			applied: { homeGiB: 25, dockerGiB: 20 },
		});
		const { controller, tick, grows } = build();
		controller.growError = new Error("boom");
		await tick();

		await tdb.db
			.updateTable("workspaces")
			.set({ quota_config: JSON.stringify({ homeGiB: 35, dockerGiB: 20 }) })
			.where("id", "=", ws.id)
			.execute();
		await tick();

		expect(grows().map((c) => c.args[1])).toEqual([
			{ homeGiB: 30, dockerGiB: 20 },
			{ homeGiB: 35, dockerGiB: 20 },
		]);
		const failed = await audits(ws.id);
		expect(failed.map((a) => (a.metadata as { errorCode: string }).errorCode)).toEqual([
			"OPERATION_FAILED",
			"OPERATION_FAILED",
		]);
	},
);

test.skipIf(skip)("a size changed during the grow is not marked applied", async () => {
	const ws = await insertWorkspace({
		config: { homeGiB: 30, dockerGiB: 20 },
		applied: { homeGiB: 25, dockerGiB: 20 },
	});
	const { controller, tick } = build();
	const grow = controller.growVolumes.bind(controller);
	controller.growVolumes = async (name, req) => {
		await tdb.db
			.updateTable("workspaces")
			.set({ quota_config: JSON.stringify({ homeGiB: 50, dockerGiB: 20 }) })
			.where("id", "=", ws.id)
			.execute();
		return grow(name, req);
	};
	await tick();
	expect(await applied(ws.id)).toEqual({ homeGiB: 25, dockerGiB: 20 });
	expect(await audits(ws.id)).toEqual([]);
});

test.skipIf(skip)("a database failure is logged and does not throw", async () => {
	const { logger, lines } = collectingLogger();
	const broken = {
		selectFrom: () => {
			throw new Error("db down");
		},
	} as unknown as TestDb["db"];
	await createQuotaSync({
		db: broken,
		controller: new FakeControllerClient(),
		logger,
	})();
	expect(lines.some((l) => l.msg === "quota sync failed")).toBe(true);
});
