import type { AdminBackups, BackupRequestView } from "@portikus/contracts";
import { json, stubFetch, USER } from "../../test-utils.js";

/** Shared sets, requests and stubs for the Backups tab's tests. */

export const OLD = "20260920T023000Z";
export const NEW = "20260924T023000Z";
export const FAILED = "20260925T023000Z";
export const ALICE_WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const BOB_WS = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const ALICE_INSTANCE = `ws-${"a".repeat(24)}`;
export const BOB_INSTANCE = `ws-${"b".repeat(24)}`;
export const COPY_ID = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export function view(overrides: Partial<BackupRequestView>): BackupRequestView {
	return {
		id: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		kind: "backup",
		args: {},
		state: "done",
		requestedAt: "2026-09-26T10:00:00.000Z",
		claimedAt: null,
		finishedAt: null,
		error: null,
		workspaceId: null,
		result: null,
		...overrides,
	};
}

export const WORKSPACES: AdminBackups["workspaces"] = [
	{
		id: ALICE_WS,
		instance: ALICE_INSTANCE,
		label: "alice",
		ownerName: "Alice Smith",
		state: "running",
	},
	{
		id: BOB_WS,
		instance: BOB_INSTANCE,
		label: "bob",
		ownerName: "Bob Jones",
		state: "stopped",
	},
];

export function backups(overrides: Partial<AdminBackups> = {}): AdminBackups {
	return {
		host: {
			vm: "portikus-vm",
			reportedAt: "2026-09-26T10:00:00.000Z",
			nextRunAt: "2026-09-27T02:30:00.000Z",
			lastRun: {
				startedAt: "2026-09-25T02:30:00.000Z",
				endedAt: "2026-09-25T02:40:00.000Z",
				result: "failed",
			},
			lastFailure: { at: "2026-09-25T02:40:00.000Z", reason: "the pool was busy" },
			running: null,
			keyInstalled: true,
			sets: [
				{
					stamp: FAILED,
					complete: false,
					sizeBytes: 1024,
					instances: [ALICE_INSTANCE],
					failedVolumes: [`${BOB_INSTANCE}-home`],
				},
				{
					stamp: NEW,
					complete: true,
					sizeBytes: 5 * 1024 ** 3,
					instances: [ALICE_INSTANCE, BOB_INSTANCE],
					failedVolumes: [],
					skippedVolumes: 2,
				},
				{
					stamp: OLD,
					complete: true,
					sizeBytes: 4 * 1024 ** 3,
					instances: [ALICE_INSTANCE, BOB_INSTANCE],
					failedVolumes: [],
				},
			],
			dumps: [
				{
					file: "portikus-pre-upgrade.dump",
					sizeBytes: 2048,
					modifiedAt: "2026-09-23T09:00:00.000Z",
				},
			],
		},
		hostReportedAt: new Date().toISOString(),
		hostStale: false,
		vm: {
			snapshots: [
				{
					volume: `${ALICE_INSTANCE}-home`,
					name: "pre-upgrade",
					createdAt: "2026-09-23T09:00:00.000Z",
				},
			],
			keptHomes: [
				{
					volume: `${ALICE_INSTANCE}-home-replaced-1790000000`,
					instance: ALICE_INSTANCE,
					createdAt: "2026-09-22T09:00:00.000Z",
				},
			],
		},
		vmListedAt: new Date().toISOString(),
		requests: [
			view({
				id: COPY_ID,
				kind: "restore_copy",
				args: { stamp: NEW, instance: ALICE_INSTANCE, dir: "restored-2026-09-24-0230" },
				workspaceId: ALICE_WS,
			}),
			view({
				id: "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				kind: "delete_set",
				args: { stamp: OLD },
				state: "failed",
				error: "refused by the host: no such set",
			}),
		],
		workspaces: WORKSPACES,
		...overrides,
	};
}

/** Serves the Backups API and records every write. */
export function stubBackups(
	data: AdminBackups,
	write: () => Response = () => json(202, view({})),
) {
	const writes: { method: string; url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/admin/backups" && (init?.method ?? "GET") === "GET") {
			return json(200, data);
		}
		// A separate host backs this site up, so the server holds no key (ADR 0044).
		if (url === "/admin/backups/key") {
			return json(404, { code: "NOT_FOUND", message: "Not found." });
		}
		if (url.startsWith("/admin/backups")) {
			writes.push({
				method: init?.method ?? "GET",
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return write();
		}
		return json(200, {});
	});
	return writes;
}
