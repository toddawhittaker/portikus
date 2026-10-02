/**
 * Backups from the admin page (SPEC.md §24.9, §24.11; ADR 0024). The API only
 * records requests for the host channel and the worker; every write is
 * administrator-only and audited, and each refusal runs nothing.
 */
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { HostBackupStatus } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();

const OLD = "20260925T023000Z";
const NEWEST = "20260926T023000Z";
const PARTIAL = "20260927T023000Z";
const DUMP = "portikus-pre-upgrade.dump";

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;
let instance: string;

function hostStatus(over: Partial<HostBackupStatus> = {}): HostBackupStatus {
	return {
		vm: "portikus-pilot",
		reportedAt: new Date().toISOString(),
		nextRunAt: null,
		lastRun: null,
		lastFailure: null,
		running: null,
		keyInstalled: true,
		sets: [
			// The newest set is incomplete, so the newest complete one is NEWEST.
			{
				stamp: PARTIAL,
				complete: false,
				sizeBytes: 1,
				instances: [instance],
				failedVolumes: ["x"],
			},
			{
				stamp: NEWEST,
				complete: true,
				sizeBytes: 2,
				instances: [instance],
				failedVolumes: [],
			},
			{ stamp: OLD, complete: true, sizeBytes: 3, instances: [], failedVolumes: [] },
		],
		dumps: [{ file: DUMP, sizeBytes: 9, modifiedAt: new Date().toISOString() }],
		...over,
	};
}

async function report(status: HostBackupStatus | null, ageSeconds = 0) {
	await testDb.db
		.updateTable("backup_status")
		.set({
			host: status ? JSON.stringify(status) : null,
			host_reported_at: status
				? new Date(Date.now() - ageSeconds * 1000).toISOString()
				: null,
		})
		.execute();
}

function send(
	jar: CookieJar,
	method: "GET" | "POST" | "DELETE",
	url: string,
	payload?: Record<string, unknown>,
) {
	return app.inject({ method, url, headers: csrfHeaders(jar, PUBLIC_URL), payload });
}

async function requests() {
	return testDb.db.selectFrom("backup_requests").selectAll().execute();
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.execute();
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running" })
		.where("id", "=", workspaceId)
		.execute();
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("incus_instance_name")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	instance = row.incus_instance_name as string;
	await report(hostStatus());
	return async () => {
		await app.close();
	};
});

describe.skipIf(skip)("reading", () => {
	test("a site whose host never reported shows no host and is stale", async () => {
		await report(null);
		const res = await send(carol, "GET", "/admin/backups");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			host: null,
			hostReportedAt: null,
			hostStale: true,
			vm: null,
			requests: [],
			workspaces: [],
		});
	});

	test("shows the host status, the requests and the workspaces the sets cover", async () => {
		await send(carol, "POST", "/admin/backups/run");
		const body = (await send(carol, "GET", "/admin/backups")).json();
		expect(body.hostStale).toBe(false);
		expect(body.host.sets.map((s: { stamp: string }) => s.stamp)).toEqual([
			PARTIAL,
			NEWEST,
			OLD,
		]);
		expect(body.requests).toMatchObject([
			{ kind: "backup", state: "pending", args: {} },
		]);
		expect(body.workspaces).toEqual([
			expect.objectContaining({ id: workspaceId, instance, state: "running" }),
		]);
	});

	test("a malformed stored document counts as no report", async () => {
		await testDb.db
			.updateTable("backup_status")
			.set({
				host: JSON.stringify({ vm: "../x" }),
				host_reported_at: new Date().toISOString(),
			})
			.execute();
		const body = (await send(carol, "GET", "/admin/backups")).json();
		expect(body.host).toBeNull();
		expect(body.hostStale).toBe(true);
	});

	test("students are refused", async () => {
		expect((await send(alice, "GET", "/admin/backups")).statusCode).toBe(403);
	});
});

describe.skipIf(skip)("Back up now", () => {
	test("records a backup request and audits it", async () => {
		const res = await send(carol, "POST", "/admin/backups/run");
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({ kind: "backup", state: "pending", args: {} });
		expect(await requests()).toHaveLength(1);
		const [audit] = await audits("backup.requested");
		expect(audit).toMatchObject({ result: "ok", target: "backups" });
		expect(audit?.actor).toMatch(/^user:/);
		expect(audit?.metadata).toMatchObject({ requestId: res.json().id });
	});

	test("a second backup while one waits is refused", async () => {
		expect((await send(carol, "POST", "/admin/backups/run")).statusCode).toBe(202);
		const res = await send(carol, "POST", "/admin/backups/run");
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("BACKUP_RUNNING");
		await testDb.db.updateTable("backup_requests").set({ state: "claimed" }).execute();
		expect((await send(carol, "POST", "/admin/backups/run")).statusCode).toBe(409);
		expect(await requests()).toHaveLength(1);
		expect(await audits("backup.requested")).toHaveLength(1);
	});

	test("a finished backup does not block the next", async () => {
		await send(carol, "POST", "/admin/backups/run");
		await testDb.db.updateTable("backup_requests").set({ state: "done" }).execute();
		expect((await send(carol, "POST", "/admin/backups/run")).statusCode).toBe(202);
	});

	test("the nightly run in progress refuses", async () => {
		await report(hostStatus({ running: "nightly" }));
		const res = await send(carol, "POST", "/admin/backups/run");
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("BACKUP_RUNNING");
	});

	test("a host silent for more than three minutes refuses, and so does none", async () => {
		await report(hostStatus(), 181);
		const stale = await send(carol, "POST", "/admin/backups/run");
		expect(stale.statusCode).toBe(409);
		expect(stale.json().code).toBe("BACKUP_HOST_STALE");
		await report(null);
		expect((await send(carol, "POST", "/admin/backups/run")).statusCode).toBe(409);
		expect(await requests()).toEqual([]);
		expect(await audits("backup.requested")).toEqual([]);
	});

	test("students are refused", async () => {
		expect((await send(alice, "POST", "/admin/backups/run")).statusCode).toBe(403);
		expect(await requests()).toEqual([]);
	});
});

describe.skipIf(skip)("deleting a set", () => {
	test("records the request and audits it", async () => {
		const res = await send(carol, "DELETE", `/admin/backups/sets/${OLD}`);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({ kind: "delete_set", args: { stamp: OLD } });
		expect(await audits("backup.set_delete_requested")).toMatchObject([
			{ target: OLD, metadata: { stamp: OLD } },
		]);
	});

	test("an incomplete set newer than the newest complete one can go", async () => {
		expect(
			(await send(carol, "DELETE", `/admin/backups/sets/${PARTIAL}`)).statusCode,
		).toBe(202);
	});

	test("the newest complete set is refused", async () => {
		const res = await send(carol, "DELETE", `/admin/backups/sets/${NEWEST}`);
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("BACKUP_NEWEST_SET");
		expect(await requests()).toEqual([]);
	});

	test("a malformed or unknown stamp is refused", async () => {
		for (const bad of ["20260925T023000Z..", "x%2F..%2Fetc", "20260925T023000Z%0A"]) {
			expect(
				(await send(carol, "DELETE", `/admin/backups/sets/${bad}`)).statusCode,
			).toBe(400);
		}
		expect(
			(await send(carol, "DELETE", "/admin/backups/sets/20200101T000000Z")).statusCode,
		).toBe(404);
		expect(await requests()).toEqual([]);
	});

	test("the same delete twice is refused while it waits", async () => {
		await send(carol, "DELETE", `/admin/backups/sets/${OLD}`);
		const res = await send(carol, "DELETE", `/admin/backups/sets/${OLD}`);
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("OPERATION_PENDING");
	});
});

describe.skipIf(skip)("deleting a dump", () => {
	test("records the request and audits it", async () => {
		const res = await send(carol, "DELETE", `/admin/backups/dumps/${DUMP}`);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({ kind: "delete_dump", args: { file: DUMP } });
		expect(await audits("backup.dump_delete_requested")).toMatchObject([
			{ target: DUMP },
		]);
	});

	test("a file outside the pattern or not listed is refused", async () => {
		expect(
			(await send(carol, "DELETE", "/admin/backups/dumps/portikus-pre-..%2Fx.dump"))
				.statusCode,
		).toBe(400);
		expect(
			(await send(carol, "DELETE", "/admin/backups/dumps/portikus-pre-other.dump"))
				.statusCode,
		).toBe(404);
		expect(await requests()).toEqual([]);
	});
});

describe.skipIf(skip)("restoring a side copy", () => {
	test("records the request with the derived folder and audits it", async () => {
		const res = await send(carol, "POST", "/admin/backups/restores", {
			stamp: NEWEST,
			workspaceId,
		});
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({
			kind: "restore_copy",
			workspaceId,
			args: { stamp: NEWEST, instance, dir: "restored-2026-09-26-0230" },
		});
		expect(await audits("backup.restore_requested")).toMatchObject([
			{ target: workspaceId, metadata: { stamp: NEWEST } },
		]);
	});

	test("a stopped workspace is refused", async () => {
		await testDb.db.updateTable("workspaces").set({ state: "stopped" }).execute();
		const res = await send(carol, "POST", "/admin/backups/restores", {
			stamp: NEWEST,
			workspaceId,
		});
		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({
			code: "WORKSPACE_NOT_RUNNING",
			message: "Start the workspace first",
		});
		expect(await requests()).toEqual([]);
	});

	test("a set that does not hold the workspace, or no such set, is refused", async () => {
		const notHeld = await send(carol, "POST", "/admin/backups/restores", {
			stamp: OLD,
			workspaceId,
		});
		expect(notHeld.statusCode).toBe(404);
		const noSet = await send(carol, "POST", "/admin/backups/restores", {
			stamp: "20200101T000000Z",
			workspaceId,
		});
		expect(noSet.statusCode).toBe(404);
		const noWs = await send(carol, "POST", "/admin/backups/restores", {
			stamp: NEWEST,
			workspaceId: crypto.randomUUID(),
		});
		expect(noWs.statusCode).toBe(404);
		const bad = await send(carol, "POST", "/admin/backups/restores", {
			stamp: "../x",
			workspaceId,
		});
		expect(bad.statusCode).toBe(400);
		expect(await requests()).toEqual([]);
	});
});

describe.skipIf(skip)("replacing a home", () => {
	async function restoreId(state: string) {
		const res = await send(carol, "POST", "/admin/backups/restores", {
			stamp: NEWEST,
			workspaceId,
		});
		const id = res.json().id as string;
		await testDb.db
			.updateTable("backup_requests")
			.set({ state })
			.where("id", "=", id)
			.execute();
		return id;
	}

	test("a finished copy sets the pending operation and audits it", async () => {
		const id = await restoreId("done");
		const res = await send(carol, "POST", `/admin/backups/restores/${id}/replace-home`);
		expect(res.statusCode).toBe(202);
		const ws = await testDb.db
			.selectFrom("workspaces")
			.select(["pending_operation", "pending_operation_args"])
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(ws).toEqual({
			pending_operation: "replace-home",
			pending_operation_args: { restoreRequestId: id },
		});
		expect(await audits("workspace.home_replace_requested")).toMatchObject([
			{ target: workspaceId, metadata: { restoreRequestId: id, stamp: NEWEST } },
		]);
		// A second click finds the operation already waiting.
		const again = await send(
			carol,
			"POST",
			`/admin/backups/restores/${id}/replace-home`,
		);
		expect(again.statusCode).toBe(409);
		expect(again.json().code).toBe("OPERATION_PENDING");
		expect(await audits("workspace.home_replace_requested")).toHaveLength(1);
	});

	test("an unfinished or failed copy is refused", async () => {
		for (const state of ["pending", "claimed", "failed"]) {
			const id = await restoreId(state);
			const res = await send(
				carol,
				"POST",
				`/admin/backups/restores/${id}/replace-home`,
			);
			expect(res.statusCode, state).toBe(409);
			expect(res.json().code).toBe("RESTORE_NOT_FINISHED");
			await testDb.db.deleteFrom("backup_requests").execute();
		}
		expect(await audits("workspace.home_replace_requested")).toEqual([]);
	});

	test("a request that is not a restore is refused", async () => {
		const id = (await send(carol, "POST", "/admin/backups/run")).json().id;
		await testDb.db.updateTable("backup_requests").set({ state: "done" }).execute();
		const res = await send(carol, "POST", `/admin/backups/restores/${id}/replace-home`);
		expect(res.statusCode).toBe(404);
		expect(
			(await send(carol, "POST", "/admin/backups/restores/nope/replace-home"))
				.statusCode,
		).toBe(400);
	});
});

describe.skipIf(skip)("VM deletes", () => {
	const snapVolume = () => `${instance}-home`;
	const kept = () => `${instance}-home-replaced-1790000000`;

	beforeEach(async () => {
		if (skip) return;
		await testDb.db
			.updateTable("backup_status")
			.set({
				vm: JSON.stringify({
					snapshots: [
						{
							volume: snapVolume(),
							name: "pre-upgrade",
							createdAt: new Date().toISOString(),
						},
					],
					keptHomes: [
						{ volume: kept(), instance, createdAt: new Date().toISOString() },
					],
				}),
				vm_listed_at: new Date().toISOString(),
			})
			.execute();
	});

	test("a listed pre-change snapshot is requested and audited", async () => {
		const res = await send(
			carol,
			"DELETE",
			`/admin/backups/snapshots/${snapVolume()}/pre-upgrade`,
		);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({
			kind: "delete_snapshot",
			args: { volume: snapVolume(), snapshot: "pre-upgrade" },
		});
		expect(await audits("backup.snapshot_delete_requested")).toHaveLength(1);
	});

	test("the backup's own snapshot and unlisted snapshots are refused", async () => {
		expect(
			(
				await send(
					carol,
					"DELETE",
					`/admin/backups/snapshots/${snapVolume()}/portikus-backup`,
				)
			).statusCode,
		).toBe(400);
		expect(
			(
				await send(
					carol,
					"DELETE",
					`/admin/backups/snapshots/${snapVolume()}/pre-other`,
				)
			).statusCode,
		).toBe(404);
		expect(await requests()).toEqual([]);
	});

	test("a listed kept home is requested and audited", async () => {
		const res = await send(carol, "DELETE", `/admin/backups/kept-homes/${kept()}`);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toMatchObject({
			kind: "delete_kept_home",
			args: { volume: kept() },
		});
		expect(await audits("backup.kept_home_delete_requested")).toMatchObject([
			{ target: kept() },
		]);
	});

	test("a live home or an unlisted kept home is refused", async () => {
		expect(
			(await send(carol, "DELETE", `/admin/backups/kept-homes/${instance}-home`))
				.statusCode,
		).toBe(400);
		expect(
			(
				await send(
					carol,
					"DELETE",
					`/admin/backups/kept-homes/${instance}-home-replaced-1`,
				)
			).statusCode,
		).toBe(404);
		expect(await requests()).toEqual([]);
	});
});
