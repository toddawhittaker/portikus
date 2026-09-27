import { BACKUP_REPORT_MAX_BYTES, type HostBackupStatus } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	acceptReport,
	BACKUP_CLAIM_TIMEOUT_MS,
	backupVmTick,
	describeStamp,
	pullRequest,
	refreshRestorePresence,
	runReplaceHome,
	runVmDeletes,
} from "./backups.js";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { type ReconcileConfig, reconcile, settleStops } from "./reconcile.js";

const skip = !hasTestDb();
let tdb: TestDb;
let fake: FakeControllerClient;

const INSTANCE = "ws-0123456789abcdef01234567";
const STAMP = "20260924T023000Z";
const NOW = new Date("2026-09-27T12:00:00Z");

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
	fake = new FakeControllerClient();
});

let labels = 0;
async function insertWorkspace(overrides: Record<string, unknown> = {}) {
	const owner = await insertTestUser(tdb.db);
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `backup-${++labels}`,
			owner_user_id: owner,
			incus_instance_name: INSTANCE,
			state: "running",
			desired_state: "running",
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, owner };
}

async function insertRequest(values: {
	kind: string;
	args?: Record<string, string>;
	state?: string;
	workspace_id?: string | null;
	requested_at?: Date;
	claimed_at?: Date | null;
	result?: unknown;
}) {
	const row = await tdb.db
		.insertInto("backup_requests")
		.values({
			kind: values.kind,
			args: JSON.stringify(values.args ?? {}),
			state: values.state ?? "pending",
			workspace_id: values.workspace_id ?? null,
			requested_at: (values.requested_at ?? NOW).toISOString(),
			claimed_at: values.claimed_at?.toISOString() ?? null,
			result: values.result === undefined ? null : JSON.stringify(values.result),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function requestRow(id: string) {
	return tdb.db
		.selectFrom("backup_requests")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

function auditRows() {
	return tdb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "action", "result", "metadata"])
		.orderBy("id")
		.execute();
}

function status(overrides: Partial<HostBackupStatus> = {}): HostBackupStatus {
	return {
		vm: "portikus-pilot",
		reportedAt: NOW.toISOString(),
		nextRunAt: null,
		lastRun: null,
		lastFailure: null,
		running: null,
		keyInstalled: true,
		sets: [
			{
				stamp: STAMP,
				complete: true,
				sizeBytes: 1024,
				instances: [INSTANCE],
				failedVolumes: [],
			},
		],
		dumps: [],
		...overrides,
	};
}

function doc(value: unknown): Buffer {
	return Buffer.from(JSON.stringify(value));
}

const restoreArgs = {
	stamp: STAMP,
	instance: INSTANCE,
	dir: "restored-2026-09-24-0230",
};

test("describeStamp reads a set's UTC time", () => {
	expect(describeStamp(STAMP)).toBe("24 September 2026, 02:30");
	expect(describeStamp("20260101T000500Z")).toBe("1 January 2026, 00:05");
});

// --- pull -----------------------------------------------------------------

test.skipIf(skip)("pull returns null when nothing waits", async () => {
	expect(await pullRequest(tdb.db, NOW)).toBeNull();
});

test.skipIf(skip)(
	"pull claims only the oldest host request, one at a time",
	async () => {
		const older = await insertRequest({
			kind: "delete_set",
			args: { stamp: "20260901T023000Z" },
			requested_at: new Date(NOW.getTime() - 60_000),
		});
		const newer = await insertRequest({ kind: "backup" });
		// VM work is never handed to the host.
		const vmWork = await insertRequest({
			kind: "delete_kept_home",
			args: { volume: `${INSTANCE}-home-replaced-1` },
			requested_at: new Date(NOW.getTime() - 120_000),
		});

		const first = await pullRequest(tdb.db, NOW);
		expect(first).toEqual({
			id: older,
			kind: "delete_set",
			args: { stamp: "20260901T023000Z" },
		});
		expect((await requestRow(older)).state).toBe("claimed");
		expect((await requestRow(newer)).state).toBe("pending");
		expect((await requestRow(vmWork)).state).toBe("pending");

		const second = await pullRequest(tdb.db, NOW);
		expect(second?.id).toBe(newer);
		expect(await pullRequest(tdb.db, NOW)).toBeNull();
	},
);

test.skipIf(skip)("pull holds a presence row for a side copy", async () => {
	const ws = await insertWorkspace();
	const id = await insertRequest({
		kind: "restore_copy",
		args: restoreArgs,
		workspace_id: ws.id,
	});
	const request = await pullRequest(tdb.db, NOW);
	expect(request).toEqual({ id, kind: "restore_copy", args: restoreArgs });
	const conns = await tdb.db
		.selectFrom("workspace_connections")
		.selectAll()
		.where("workspace_id", "=", ws.id)
		.execute();
	expect(conns).toHaveLength(1);
	expect((await requestRow(id)).result).toEqual({ connectionId: conns[0]?.id });

	// The worker keeps it fresh while the host runs the copy.
	const later = new Date(NOW.getTime() + 600_000);
	await refreshRestorePresence(tdb.db, later);
	const fresh = await tdb.db
		.selectFrom("workspace_connections")
		.select("last_seen_at")
		.where("id", "=", conns[0]?.id as string)
		.executeTakeFirstOrThrow();
	expect(fresh.last_seen_at.getTime()).toBe(later.getTime());
});

test.skipIf(skip)("pull fails a request stored with bad arguments", async () => {
	const id = await insertRequest({ kind: "delete_set", args: { stamp: "../etc" } });
	expect(await pullRequest(tdb.db, NOW)).toBeNull();
	const row = await requestRow(id);
	expect(row.state).toBe("failed");
	expect(row.error).toBe("invalid request");
});

test.skipIf(skip)(
	"pull marks a long-claimed request interrupted unless the host runs it",
	async () => {
		const ws = await insertWorkspace();
		const old = new Date(NOW.getTime() - BACKUP_CLAIM_TIMEOUT_MS - 1000);
		const conn = await tdb.db
			.insertInto("workspace_connections")
			.values({ workspace_id: ws.id })
			.returning("id")
			.executeTakeFirstOrThrow();
		const lost = await insertRequest({
			kind: "restore_copy",
			args: restoreArgs,
			state: "claimed",
			claimed_at: old,
			workspace_id: ws.id,
			result: { connectionId: conn.id },
		});
		const running = await insertRequest({
			kind: "delete_set",
			args: { stamp: "20260901T023000Z" },
			state: "claimed",
			claimed_at: old,
		});
		const recent = await insertRequest({
			kind: "backup",
			state: "claimed",
			claimed_at: new Date(NOW.getTime() - 60_000),
		});
		await tdb.db
			.updateTable("backup_status")
			.set({ host: JSON.stringify(status({ running })) })
			.execute();

		expect(await pullRequest(tdb.db, NOW)).toBeNull();

		const lostRow = await requestRow(lost);
		expect(lostRow.state).toBe("failed");
		expect(lostRow.error).toBe("interrupted");
		expect((await requestRow(running)).state).toBe("claimed");
		expect((await requestRow(recent)).state).toBe("claimed");
		// Its presence row goes, so the grace period applies again.
		const conns = await tdb.db
			.selectFrom("workspace_connections")
			.selectAll()
			.execute();
		expect(conns).toHaveLength(0);
		expect(await auditRows()).toEqual([
			expect.objectContaining({
				actor: "host",
				target: ws.id,
				action: "backup.restore_failed",
				result: "failed",
			}),
		]);
	},
);

// --- report ---------------------------------------------------------------

test.skipIf(skip)("report stores the status whole with no request", async () => {
	const out = await acceptReport(tdb.db, doc({ request: null, status: status() }), NOW);
	expect(out).toEqual({ ok: true, warning: null });
	const row = await tdb.db
		.selectFrom("backup_status")
		.selectAll()
		.executeTakeFirstOrThrow();
	expect(row.host).toEqual(status());
	expect(row.host_reported_at?.getTime()).toBe(NOW.getTime());
});

test.skipIf(skip)(
	"report refuses an oversized, malformed or unknown document",
	async () => {
		const big = Buffer.alloc(BACKUP_REPORT_MAX_BYTES + 1, 0x20);
		expect(await acceptReport(tdb.db, big, NOW)).toEqual({
			ok: false,
			error: expect.stringContaining("larger than"),
		});
		expect(await acceptReport(tdb.db, Buffer.from("{nope"), NOW)).toEqual({
			ok: false,
			error: "the report is not JSON",
		});
		const extra = { request: null, status: { ...status(), extra: 1 } };
		expect((await acceptReport(tdb.db, doc(extra), NOW)).ok).toBe(false);
		const badSet = {
			request: null,
			status: status({
				sets: [
					{
						stamp: "../x",
						complete: true,
						sizeBytes: 1,
						instances: [],
						failedVolumes: [],
					},
				],
			}),
		};
		expect(await acceptReport(tdb.db, doc(badSet), NOW)).toEqual({
			ok: false,
			error: "the report does not match the schema at status.sets.0.stamp",
		});
		// Nothing refused was stored.
		const row = await tdb.db
			.selectFrom("backup_status")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.host).toBeNull();
	},
);

test.skipIf(skip)("report finishes a backup with its stamp and audit row", async () => {
	const id = await insertRequest({ kind: "backup", state: "claimed", claimed_at: NOW });
	const out = await acceptReport(
		tdb.db,
		doc({
			request: { id, state: "done", error: null, stamp: STAMP },
			status: status(),
		}),
		NOW,
	);
	expect(out.ok).toBe(true);
	const row = await requestRow(id);
	expect(row.state).toBe("done");
	expect(row.result).toEqual({ stamp: STAMP });
	expect(row.finished_at?.getTime()).toBe(NOW.getTime());
	expect(await auditRows()).toEqual([
		{
			actor: "host",
			target: "backups",
			action: "backup.completed",
			result: "ok",
			metadata: { requestId: id, stamp: STAMP },
		},
	]);
});

test.skipIf(skip)("report records a failure with the host's reason", async () => {
	const id = await insertRequest({
		kind: "delete_dump",
		args: { file: "portikus-pre-upgrade.dump" },
		state: "claimed",
		claimed_at: NOW,
	});
	await acceptReport(
		tdb.db,
		doc({
			request: { id, state: "failed", error: "refused by the host", stamp: null },
			status: status(),
		}),
		NOW,
	);
	const row = await requestRow(id);
	expect(row.state).toBe("failed");
	expect(row.error).toBe("refused by the host");
	expect(await auditRows()).toEqual([
		{
			actor: "host",
			target: "portikus-pre-upgrade.dump",
			action: "backup.dump_delete_failed",
			result: "failed",
			metadata: { requestId: id, error: "refused by the host" },
		},
	]);
});

test.skipIf(skip)(
	"a finished side copy notifies the student and drops presence",
	async () => {
		const ws = await insertWorkspace();
		const id = await insertRequest({
			kind: "restore_copy",
			args: restoreArgs,
			workspace_id: ws.id,
		});
		await pullRequest(tdb.db, NOW);
		await acceptReport(
			tdb.db,
			doc({
				request: { id, state: "done", error: null, stamp: null },
				status: status(),
			}),
			NOW,
		);
		const notes = await tdb.db
			.selectFrom("notifications")
			.select(["user_id", "tone", "body"])
			.execute();
		expect(notes).toEqual([
			{
				user_id: ws.owner,
				tone: "success",
				body: "An administrator restored a copy of your files from 24 September 2026, 02:30 into ~/restored-2026-09-24-0230.",
			},
		]);
		expect(
			await tdb.db.selectFrom("workspace_connections").selectAll().execute(),
		).toEqual([]);
		expect((await auditRows()).map((a) => a.action)).toEqual(["backup.restore_copied"]);
		expect((await requestRow(id)).result).toBeNull();
	},
);

test.skipIf(skip)("a failed side copy does not notify the student", async () => {
	const ws = await insertWorkspace();
	const id = await insertRequest({
		kind: "restore_copy",
		args: restoreArgs,
		workspace_id: ws.id,
	});
	await pullRequest(tdb.db, NOW);
	await acceptReport(
		tdb.db,
		doc({
			request: { id, state: "failed", error: "~/x already exists", stamp: null },
			status: status(),
		}),
		NOW,
	);
	expect(await tdb.db.selectFrom("notifications").selectAll().execute()).toEqual([]);
	expect((await auditRows()).map((a) => a.action)).toEqual(["backup.restore_failed"]);
});

test.skipIf(skip)(
	"report ignores a result for a request that is not claimed",
	async () => {
		const pending = await insertRequest({ kind: "backup" });
		const vmWork = await insertRequest({
			kind: "delete_kept_home",
			args: { volume: `${INSTANCE}-home-replaced-1` },
			state: "claimed",
		});
		for (const id of [pending, vmWork, "00000000-0000-4000-8000-000000000000"]) {
			const out = await acceptReport(
				tdb.db,
				doc({
					request: { id, state: "done", error: null, stamp: null },
					status: status(),
				}),
				NOW,
			);
			expect(out).toEqual({ ok: true, warning: expect.stringContaining("ignored") });
		}
		expect((await requestRow(pending)).state).toBe("pending");
		expect((await requestRow(vmWork)).state).toBe("claimed");
		expect(await auditRows()).toEqual([]);
	},
);

// --- VM loop --------------------------------------------------------------

test.skipIf(skip)("the loop lists kept volumes into backup_status", async () => {
	fake.keptVolumesResult = {
		snapshots: [
			{ volume: `${INSTANCE}-home`, name: "pre-upgrade", createdAt: NOW.toISOString() },
		],
		keptHomes: [
			{
				volume: `${INSTANCE}-home-replaced-1790000000`,
				instance: INSTANCE,
				createdAt: NOW.toISOString(),
			},
		],
	};
	await backupVmTick({
		db: tdb.db,
		controller: fake,
		logger: collectingLogger().logger,
	});
	const row = await tdb.db
		.selectFrom("backup_status")
		.selectAll()
		.executeTakeFirstOrThrow();
	expect(row.vm).toEqual(fake.keptVolumesResult);
	expect(row.vm_listed_at).not.toBeNull();
});

test.skipIf(skip)(
	"the loop lists again only after five minutes, or right after a delete",
	async () => {
		const logger = collectingLogger().logger;
		let at = NOW.getTime();
		const tick = () =>
			backupVmTick({ db: tdb.db, controller: fake, logger, now: () => new Date(at) });
		const lists = () => fake.calls.filter((c) => c.method === "keptVolumes").length;

		await tick();
		expect(lists()).toBe(1);
		at += 30_000;
		await tick();
		expect(lists()).toBe(1);

		await insertRequest({
			kind: "delete_snapshot",
			args: { volume: `${INSTANCE}-docker`, snapshot: "pre-upgrade" },
		});
		at += 30_000;
		await tick();
		expect(lists()).toBe(2);

		at += 299_000;
		await tick();
		expect(lists()).toBe(2);
		at += 1_000;
		await tick();
		expect(lists()).toBe(3);
	},
);

test.skipIf(skip)(
	"the loop logs a listing failure and keeps the old listing",
	async () => {
		fake.keptVolumesResult = new ControllerClientError("INCUS_UNAVAILABLE", "down");
		const { logger, lines } = collectingLogger();
		await backupVmTick({ db: tdb.db, controller: fake, logger });
		const row = await tdb.db
			.selectFrom("backup_status")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.vm).toBeNull();
		expect(lines.some((l) => l.msg === "backup volume loop error")).toBe(true);
	},
);

test.skipIf(skip)("deletes run through the controller with audit rows", async () => {
	const snap = await insertRequest({
		kind: "delete_snapshot",
		args: { volume: `${INSTANCE}-docker`, snapshot: "pre-upgrade" },
	});
	const kept = await insertRequest({
		kind: "delete_kept_home",
		args: { volume: `${INSTANCE}-home-replaced-5` },
		requested_at: new Date(NOW.getTime() + 1000),
	});
	// A host request is left for the host.
	const host = await insertRequest({ kind: "backup" });

	expect(await runVmDeletes(tdb.db, fake, () => NOW)).toBe(2);
	expect(fake.calls).toEqual([
		{ method: "deleteSnapshot", args: [`${INSTANCE}-docker`, "pre-upgrade"] },
		{ method: "deleteKeptHome", args: [`${INSTANCE}-home-replaced-5`] },
	]);
	expect((await requestRow(snap)).state).toBe("done");
	expect((await requestRow(kept)).state).toBe("done");
	expect((await requestRow(host)).state).toBe("pending");
	expect(await auditRows()).toEqual([
		{
			actor: "worker",
			target: `${INSTANCE}-docker`,
			action: "backup.snapshot_deleted",
			result: "ok",
			metadata: {
				requestId: snap,
				volume: `${INSTANCE}-docker`,
				snapshot: "pre-upgrade",
			},
		},
		{
			actor: "worker",
			target: `${INSTANCE}-home-replaced-5`,
			action: "backup.kept_home_deleted",
			result: "ok",
			metadata: { requestId: kept, volume: `${INSTANCE}-home-replaced-5` },
		},
	]);
});

test.skipIf(skip)("a refused delete fails; one already gone is done", async () => {
	const refused = await insertRequest({
		kind: "delete_kept_home",
		args: { volume: `${INSTANCE}-home-replaced-5` },
	});
	fake.deleteError = new ControllerClientError("OPERATION_FAILED", "volume in use");
	await runVmDeletes(tdb.db, fake, () => NOW);
	const row = await requestRow(refused);
	expect(row.state).toBe("failed");
	expect(row.error).toBe("volume in use");
	expect((await auditRows()).map((a) => [a.action, a.result])).toEqual([
		["backup.kept_home_delete_failed", "failed"],
	]);

	// A claimed one left by a worker that died runs again.
	const gone = await insertRequest({
		kind: "delete_snapshot",
		args: { volume: `${INSTANCE}-home`, snapshot: "pre-x" },
		state: "claimed",
	});
	fake.deleteError = new ControllerClientError("NOT_FOUND", "no such snapshot");
	await runVmDeletes(tdb.db, fake, () => NOW);
	expect((await requestRow(gone)).state).toBe("done");
});

// --- replace home ---------------------------------------------------------

async function replaceSetup(state = "stopped") {
	const ws = await insertWorkspace({ state, desired_state: "running" });
	const restore = await insertRequest({
		kind: "restore_copy",
		args: restoreArgs,
		state: "done",
		workspace_id: ws.id,
	});
	await tdb.db
		.updateTable("workspaces")
		.set({
			pending_operation: "replace-home",
			pending_operation_args: JSON.stringify({ restoreRequestId: restore }),
			pending_operation_at: new Date(1_789_000_000_000).toISOString(),
			pending_operation_by: ws.owner,
		})
		.where("id", "=", ws.id)
		.execute();
	return { ...ws, restore };
}

async function wsRow(id: string) {
	return tdb.db
		.selectFrom("workspaces")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

async function step(id: string) {
	const w = await wsRow(id);
	return runReplaceHome(
		tdb.db,
		fake,
		{
			id,
			instance: INSTANCE,
			state: w.state,
			pendingAt: w.pending_operation_at,
			pendingBy: w.pending_operation_by,
			args: w.pending_operation_args,
		},
		NOW,
	);
}

async function finishImport(id: string, state: "done" | "failed", error?: string) {
	const args = (await wsRow(id)).pending_operation_args as { importRequestId: string };
	await tdb.db
		.updateTable("backup_requests")
		.set({ state, error: error ?? null })
		.where("id", "=", args.importRequestId)
		.execute();
	return args.importRequestId;
}

test.skipIf(skip)("replace home imports, swaps, and notifies", async () => {
	const ws = await replaceSetup();
	expect(await step(ws.id)).toBe(0);
	const args = (await wsRow(ws.id)).pending_operation_args as {
		restoreRequestId: string;
		importRequestId: string;
	};
	expect(args.restoreRequestId).toBe(ws.restore);
	const imported = await requestRow(args.importRequestId);
	expect(imported).toMatchObject({
		kind: "import_home",
		state: "pending",
		args: { stamp: STAMP, instance: INSTANCE },
		workspace_id: ws.id,
		requested_by: ws.owner,
	});
	// The host gets it through the channel.
	expect((await pullRequest(tdb.db, NOW))?.id).toBe(args.importRequestId);

	// Still importing: nothing happens.
	expect(await step(ws.id)).toBe(0);
	expect(fake.calls).toEqual([]);

	await finishImport(ws.id, "done");
	expect(await step(ws.id)).toBe(0);
	expect(fake.calls).toEqual([{ method: "replaceHome", args: [INSTANCE] }]);
	const after = await wsRow(ws.id);
	expect(after.pending_operation).toBeNull();
	expect(after.pending_operation_args).toBeNull();
	expect(after.state).toBe("stopped");
	// Left as it was, so the sweep starts it again.
	expect(after.desired_state).toBe("running");
	const done = (await auditRows()).at(-1);
	expect(done).toMatchObject({
		actor: "worker",
		target: ws.id,
		action: "workspace.home_replaced",
		result: "ok",
		metadata: {
			restoreRequestId: ws.restore,
			stamp: STAMP,
			kept: "ws-0123456789abcdef01234567-home-replaced-1790000000",
		},
	});
	const notes = await tdb.db
		.selectFrom("notifications")
		.select(["tone", "body"])
		.execute();
	expect(notes).toEqual([
		{
			tone: "success",
			body: "An administrator replaced your home folder with the backup from 24 September 2026, 02:30. Your previous home folder is kept, and your projects have recovery points from just before.",
		},
	]);
});

test.skipIf(skip)("a failed import leaves the home and the state alone", async () => {
	const ws = await replaceSetup();
	await step(ws.id);
	await finishImport(ws.id, "failed", "refused by the host");
	expect(await step(ws.id)).toBe(0);
	const after = await wsRow(ws.id);
	expect(after.pending_operation).toBeNull();
	expect(after.state).toBe("stopped");
	expect(after.error_message).toBeNull();
	expect(fake.calls).toEqual([]);
	expect((await auditRows()).at(-1)).toMatchObject({
		action: "workspace.home_replace_failed",
		result: "failed",
		metadata: { error: "the host could not import the home: refused by the host" },
	});
	const notes = await tdb.db
		.selectFrom("notifications")
		.select(["tone", "body"])
		.execute();
	expect(notes[0]?.tone).toBe("danger");
	expect(notes[0]?.body).toContain("Your files are unchanged.");
});

test.skipIf(skip)(
	"an unreachable controller is retried on the next sweep",
	async () => {
		const ws = await replaceSetup();
		await step(ws.id);
		await finishImport(ws.id, "done");
		fake.replaceHomeResult = new ControllerClientError("INCUS_UNAVAILABLE", "down");
		expect(await step(ws.id)).toBe(0);
		expect((await wsRow(ws.id)).pending_operation).toBe("replace-home");

		// The first swap finished after all: the retry sees its kept home.
		fake.replaceHomeResult = new ControllerClientError("NOT_FOUND", "no import");
		fake.keptVolumesResult = {
			snapshots: [],
			keptHomes: [
				// Older than this operation: not ours.
				{
					volume: `${INSTANCE}-home-replaced-1000`,
					instance: INSTANCE,
					createdAt: NOW.toISOString(),
				},
				{
					volume: `${INSTANCE}-home-replaced-1789000100`,
					instance: INSTANCE,
					createdAt: NOW.toISOString(),
				},
			],
		};
		await step(ws.id);
		const after = await wsRow(ws.id);
		expect(after.pending_operation).toBeNull();
		expect((await auditRows()).at(-1)).toMatchObject({
			action: "workspace.home_replaced",
			metadata: { kept: `${INSTANCE}-home-replaced-1789000100` },
		});
	},
);

test.skipIf(skip)(
	"a missing import with no kept home fails without touching",
	async () => {
		const ws = await replaceSetup();
		await step(ws.id);
		await finishImport(ws.id, "done");
		fake.replaceHomeResult = new ControllerClientError("NOT_FOUND", "no import");
		await step(ws.id);
		const after = await wsRow(ws.id);
		expect(after.pending_operation).toBeNull();
		expect(after.state).toBe("stopped");
		expect((await auditRows()).at(-1)?.action).toBe("workspace.home_replace_failed");
	},
);

test.skipIf(skip)(
	"a swap that fails part-way leaves the workspace in error",
	async () => {
		const ws = await replaceSetup();
		await step(ws.id);
		await finishImport(ws.id, "done");
		fake.replaceHomeResult = new ControllerClientError(
			"OPERATION_FAILED",
			"rename failed",
		);
		expect(await step(ws.id)).toBe(1);
		const after = await wsRow(ws.id);
		expect(after.state).toBe("error");
		expect(after.error_code).toBe("OPERATION_FAILED");
		expect(after.error_message).toBe(
			"Your home folder could not be replaced. Please contact your administrator.",
		);
		expect((await auditRows()).at(-1)).toMatchObject({
			action: "workspace.home_replace_failed",
			metadata: { error: "rename failed" },
		});
	},
);

test.skipIf(skip)("a missing restore request fails the operation", async () => {
	const ws = await replaceSetup();
	await tdb.db.deleteFrom("backup_requests").execute();
	await step(ws.id);
	expect((await wsRow(ws.id)).pending_operation).toBeNull();
	expect((await auditRows()).at(-1)?.metadata).toMatchObject({
		error: "the restore request is missing",
	});
});

const cfg: ReconcileConfig = {
	PRESENCE_TTL_SECONDS: 60,
	SHUTDOWN_GRACE_SECONDS: 600,
	START_TIMEOUT_SECONDS: 60,
	STOP_TIMEOUT_SECONDS: 30,
	STATUS_REFRESH_SECONDS: 15,
	WORKSPACE_HOME_SIZE_GIB: 25,
	WORKSPACE_DOCKER_SIZE_GIB: 20,
	WORKSPACE_RECOVERY_SIZE_GIB: 3,
	PREVIEW_SUFFIX: "preview.portikus.example.edu",
};

test.skipIf(skip)(
	"the sweep waits for recovery points, stops, replaces, and starts again",
	async () => {
		const ws = await replaceSetup("running");
		const project = await tdb.db
			.insertInto("projects")
			.values({
				workspace_id: ws.id,
				slug: "demo",
				name: "demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const sweepAt = async (at: Date) => {
			await reconcile(tdb.db, fake, cfg, at, at, false);
			await settleStops();
		};

		// No point tried since the request: the workspace keeps running.
		await sweepAt(NOW);
		expect((await wsRow(ws.id)).state).toBe("running");

		// The recovery loop tried each project.
		await tdb.db
			.updateTable("projects")
			.set({ recovery_checked_at: NOW.toISOString() })
			.where("id", "=", project.id)
			.execute();
		await sweepAt(NOW);
		expect(fake.calls.map((c) => c.method)).toContain("stop");
		expect((await wsRow(ws.id)).state).toBe("stopped");

		// Stopped: the next sweep records the import.
		await sweepAt(NOW);
		await finishImport(ws.id, "done");
		await sweepAt(NOW);
		expect(fake.calls.map((c) => c.method)).toContain("replaceHome");
		expect((await wsRow(ws.id)).pending_operation).toBeNull();

		// desired_state is still running, so the next sweep starts it.
		await sweepAt(NOW);
		expect(fake.calls.map((c) => c.method)).toContain("start");
	},
);
