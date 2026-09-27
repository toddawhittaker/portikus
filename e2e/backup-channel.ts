import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type {
	BackupChannelReport,
	BackupChannelRequest,
	BackupVmListing,
	HostBackupSet,
	HostBackupStatus,
} from "../packages/contracts/src/backups";
import { query } from "./helpers";

/**
 * Plays the host's side of the backup channel (SPEC.md §24.9; ADR 0039): the
 * real `backup-channel-main.js` pull and report, fed fixture documents. The
 * worker does not run end to end, so the VM listing is written directly.
 */

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";
const MAIN = join(process.cwd(), "apps/worker/dist/backup-channel-main.js");

function channel(command: "pull" | "report", input = ""): string {
	const run = spawnSync(process.execPath, [MAIN, command], {
		input,
		env: { PATH: process.env.PATH ?? "", DATABASE_URL },
		encoding: "utf8",
	});
	if (run.status !== 0) {
		throw new Error(`backup-channel ${command} exited ${run.status}: ${run.stderr}`);
	}
	return run.stdout;
}

/** `portikus backup-channel pull`: the claimed request, or null. */
export function hostPull(): BackupChannelRequest | null {
	const line = channel("pull").trim();
	return line ? (JSON.parse(line) as BackupChannelRequest) : null;
}

/** `portikus backup-channel report` with this status and request result. */
export function hostReport(
	status: HostBackupStatus,
	request: BackupChannelReport["request"] = null,
): void {
	channel("report", JSON.stringify({ request, status }));
}

export function backupSet(
	stamp: string,
	instances: string[],
	overrides: Partial<HostBackupSet> = {},
): HostBackupSet {
	return {
		stamp,
		complete: true,
		sizeBytes: 3 * 1024 ** 3,
		instances,
		failedVolumes: [],
		...overrides,
	};
}

/** A healthy host: fresh, key in place, nothing running. */
export function hostStatus(
	overrides: Partial<HostBackupStatus> = {},
): HostBackupStatus {
	return {
		vm: "portikus-e2e",
		reportedAt: new Date().toISOString(),
		nextRunAt: "2026-09-28T02:30:00.000Z",
		lastRun: {
			startedAt: "2026-09-27T02:30:00.000Z",
			endedAt: "2026-09-27T02:41:00.000Z",
			result: "success",
		},
		lastFailure: null,
		running: null,
		keyInstalled: true,
		sets: [],
		dumps: [],
		...overrides,
	};
}

/** What the worker's listing loop would store from the controller. */
export async function setVmListing(listing: BackupVmListing | null): Promise<void> {
	await query(
		"update backup_status set vm = $1::jsonb, vm_listed_at = now() where id = 1",
		[listing === null ? null : JSON.stringify(listing)],
	);
}

/** Forget every request and report, so each test starts from a clean channel. */
export async function resetBackups(): Promise<void> {
	await query("delete from backup_requests");
	await query(
		"update backup_status set host = null, host_reported_at = null, vm = null, vm_listed_at = null where id = 1",
	);
}
