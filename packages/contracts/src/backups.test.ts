/**
 * The backup channel's shapes (SPEC.md §24.9; ADR 0024). Everything the VM
 * hands the host is a strict pattern, so a lying value never reaches a path.
 */
import { describe, expect, test } from "vitest";
import {
	BACKUP_REPORT_MAX_BYTES,
	BackupChannelReport,
	BackupChannelRequest,
	BackupDumpFile,
	BackupKeptHome,
	BackupRequestArgs,
	BackupSnapshotName,
	BackupSnapshotVolume,
	BackupStamp,
	type HostBackupStatus,
	restoreDirFor,
} from "./backups.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const INSTANCE = `ws-${"a".repeat(24)}`;

const status: HostBackupStatus = {
	vm: "portikus-pilot",
	reportedAt: "2026-09-27T10:00:00Z",
	nextRunAt: "2026-09-28T02:30:00Z",
	lastRun: {
		startedAt: "2026-09-27T02:30:00Z",
		endedAt: "2026-09-27T02:41:00Z",
		result: "success",
	},
	lastFailure: null,
	running: null,
	keyInstalled: true,
	sets: [
		{
			stamp: "20260927T023000Z",
			complete: true,
			sizeBytes: 123,
			instances: [INSTANCE],
			failedVolumes: [],
		},
	],
	dumps: [
		{
			file: "portikus-pre-upgrade.dump",
			sizeBytes: 9,
			modifiedAt: "2026-09-26T12:00:00Z",
		},
	],
};

describe("patterns", () => {
	test.each(["20260924T023000Z"])("accepts the stamp %s", (s) =>
		expect(BackupStamp.safeParse(s).success).toBe(true),
	);

	test.each([
		"../20260924T023000Z",
		"20260924T023000Z/..",
		"20260924T023000Z\n",
		"2026-09-24T02:30:00Z",
		"",
	])("refuses the stamp %j", (s) =>
		expect(BackupStamp.safeParse(s).success).toBe(false),
	);

	test.each([
		"portikus-pre-../x.dump",
		"portikus-pre-a/b.dump",
		"portikus-pre-.dump",
		"portikus-pre-A.dump",
		"portikus-pre-x.dump\n",
		"other.dump",
	])("refuses the dump %j", (s) =>
		expect(BackupDumpFile.safeParse(s).success).toBe(false),
	);

	test("accepts a pre-change dump", () => {
		expect(BackupDumpFile.safeParse("portikus-pre-epic-24.dump").success).toBe(true);
	});

	test("only pre-* snapshots on workspace volumes, never the backup's own", () => {
		expect(BackupSnapshotName.safeParse("pre-upgrade").success).toBe(true);
		expect(BackupSnapshotName.safeParse("portikus-backup").success).toBe(false);
		expect(BackupSnapshotVolume.safeParse(`${INSTANCE}-docker`).success).toBe(true);
		expect(BackupSnapshotVolume.safeParse(`${INSTANCE}-root`).success).toBe(false);
	});

	test("only kept homes", () => {
		expect(
			BackupKeptHome.safeParse(`${INSTANCE}-home-replaced-1790000000`).success,
		).toBe(true);
		expect(BackupKeptHome.safeParse(`${INSTANCE}-home`).success).toBe(false);
	});
});

test("the side-copy folder comes from the set's UTC time", () => {
	expect(restoreDirFor("20260924T023000Z")).toBe("restored-2026-09-24-0230");
	expect(() => restoreDirFor("../etc")).toThrow();
});

describe("the pulled request", () => {
	test("accepts each host kind", () => {
		for (const line of [
			{ id: ID, kind: "backup", args: {} },
			{ id: ID, kind: "delete_set", args: { stamp: "20260924T023000Z" } },
			{ id: ID, kind: "delete_dump", args: { file: "portikus-pre-x.dump" } },
			{
				id: ID,
				kind: "restore_copy",
				args: {
					stamp: "20260924T023000Z",
					instance: INSTANCE,
					dir: "restored-2026-09-24-0230",
				},
			},
			{
				id: ID,
				kind: "import_home",
				args: { stamp: "20260924T023000Z", instance: INSTANCE },
			},
		]) {
			expect(BackupChannelRequest.safeParse(line).success, line.kind).toBe(true);
		}
	});

	test("refuses VM work, unknown kinds, extra fields and a mismatched folder", () => {
		for (const line of [
			{ id: ID, kind: "delete_snapshot", args: { volume: "x", snapshot: "pre-x" } },
			{ id: ID, kind: "rm", args: {} },
			{ id: ID, kind: "backup", args: { extra: "1" } },
			{
				id: ID,
				kind: "restore_copy",
				args: {
					stamp: "20260924T023000Z",
					instance: INSTANCE,
					dir: "restored-2026-09-24-0231",
				},
			},
		]) {
			expect(BackupChannelRequest.safeParse(line).success).toBe(false);
		}
	});

	test("every stored kind has an argument schema", () => {
		expect(Object.keys(BackupRequestArgs).sort()).toEqual(
			[
				"backup",
				"delete_dump",
				"delete_kept_home",
				"delete_set",
				"delete_snapshot",
				"import_home",
				"restore_copy",
			].sort(),
		);
	});
});

describe("the report", () => {
	test("accepts a status with and without a finished request", () => {
		expect(BackupChannelReport.safeParse({ request: null, status }).success).toBe(true);
		expect(
			BackupChannelReport.safeParse({
				request: { id: ID, state: "done", error: null, stamp: "20260927T023000Z" },
				status,
			}).success,
		).toBe(true);
	});

	test("refuses more than 60 sets and an unknown field", () => {
		const many = { ...status, sets: Array(61).fill(status.sets[0]) };
		expect(BackupChannelReport.safeParse({ request: null, status: many }).success).toBe(
			false,
		);
		expect(
			BackupChannelReport.safeParse({ request: null, status: { ...status, key: "x" } })
				.success,
		).toBe(false);
	});

	test("the size cap is 256 KiB", () => {
		expect(BACKUP_REPORT_MAX_BYTES).toBe(262144);
	});
});
