import { z } from "zod";
import {
	KeptHomeVolumeName,
	PreChangeSnapshotName,
	WorkspaceVolumeName,
} from "./controller.js";

/**
 * Backups run from the admin page (SPEC.md §24.9, §24.11; ADR 0024). The API
 * records a request row; a host timer pulls it over SSH, runs it, and reports
 * the result and a fresh status. The VM never writes to the host, and the host
 * checks every value below again before it reaches a command or a path.
 */

/** A set's directory name: its UTC start time, as `backup.sh` writes it. */
export const BACKUP_STAMP_PATTERN = /^[0-9]{8}T[0-9]{6}Z$/;
/** A pre-change database dump in the VM's `dumps/` directory on the host. */
export const BACKUP_DUMP_PATTERN = /^portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump$/;
/** A workspace's Incus instance name. */
export const BACKUP_INSTANCE_PATTERN = /^ws-[0-9a-f]{24}$/;
/** The side-copy folder in `/home/student`, derived from the set's stamp. */
export const BACKUP_RESTORE_DIR_PATTERN =
	/^restored-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$/;

/** A host status older than this is stale, and Back up now waits. */
export const BACKUP_HOST_STALE_SECONDS = 180;
/** The largest report document the VM accepts from the host. */
export const BACKUP_REPORT_MAX_BYTES = 256 * 1024;

export const BackupStamp = z.string().regex(BACKUP_STAMP_PATTERN);
export const BackupDumpFile = z.string().regex(BACKUP_DUMP_PATTERN);
export const BackupInstance = z.string().regex(BACKUP_INSTANCE_PATTERN);
export const BackupRestoreDir = z.string().regex(BACKUP_RESTORE_DIR_PATTERN);
/** The controller's own names, so the API and the controller check the same forms. */
export const BackupSnapshotVolume = WorkspaceVolumeName;
export const BackupSnapshotName = PreChangeSnapshotName;
export const BackupKeptHome = KeptHomeVolumeName;

/** `20260924T023000Z` becomes `restored-2026-09-24-0230`. */
export function restoreDirFor(stamp: string): string {
	if (!BACKUP_STAMP_PATTERN.test(stamp)) throw new Error("not a backup stamp");
	const d = stamp;
	return `restored-${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}-${d.slice(9, 13)}`;
}

/** The kinds the host runs; the last two are VM work the worker does. */
export const BackupHostKind = z.enum([
	"backup",
	"delete_set",
	"delete_dump",
	"restore_copy",
	"import_home",
]);
export type BackupHostKind = z.infer<typeof BackupHostKind>;

export const BackupRequestKind = z.enum([
	...BackupHostKind.options,
	"delete_snapshot",
	"delete_kept_home",
]);
export type BackupRequestKind = z.infer<typeof BackupRequestKind>;

export const BackupRequestState = z.enum(["pending", "claimed", "done", "failed"]);
export type BackupRequestState = z.infer<typeof BackupRequestState>;

const BackupArgs = z.object({}).strict();
const DeleteSetArgs = z.object({ stamp: BackupStamp }).strict();
const DeleteDumpArgs = z.object({ file: BackupDumpFile }).strict();
const RestoreCopyArgs = z
	.object({ stamp: BackupStamp, instance: BackupInstance, dir: BackupRestoreDir })
	.strict()
	.refine((a) => a.dir === restoreDirFor(a.stamp), {
		message: "dir does not match stamp",
	});
const ImportHomeArgs = z
	.object({ stamp: BackupStamp, instance: BackupInstance })
	.strict();
const DeleteSnapshotArgs = z
	.object({ volume: BackupSnapshotVolume, snapshot: BackupSnapshotName })
	.strict();
const DeleteKeptHomeArgs = z.object({ volume: BackupKeptHome }).strict();

/**
 * The one JSON line `portikus backup-channel pull` prints: a claimed request
 * the host runs. Only the five host kinds are ever handed out.
 */
export const BackupChannelRequest = z.discriminatedUnion("kind", [
	z
		.object({ id: z.string().uuid(), kind: z.literal("backup"), args: BackupArgs })
		.strict(),
	z
		.object({
			id: z.string().uuid(),
			kind: z.literal("delete_set"),
			args: DeleteSetArgs,
		})
		.strict(),
	z
		.object({
			id: z.string().uuid(),
			kind: z.literal("delete_dump"),
			args: DeleteDumpArgs,
		})
		.strict(),
	z
		.object({
			id: z.string().uuid(),
			kind: z.literal("restore_copy"),
			args: RestoreCopyArgs,
		})
		.strict(),
	z
		.object({
			id: z.string().uuid(),
			kind: z.literal("import_home"),
			args: ImportHomeArgs,
		})
		.strict(),
]);
export type BackupChannelRequest = z.infer<typeof BackupChannelRequest>;

/** The arguments each kind stores in `backup_requests.args`. */
export const BackupRequestArgs = {
	backup: BackupArgs,
	delete_set: DeleteSetArgs,
	delete_dump: DeleteDumpArgs,
	restore_copy: RestoreCopyArgs,
	import_home: ImportHomeArgs,
	delete_snapshot: DeleteSnapshotArgs,
	delete_kept_home: DeleteKeptHomeArgs,
} as const;

const Timestamp = z.string().datetime({ offset: true });

export const HostBackupSet = z
	.object({
		stamp: BackupStamp,
		complete: z.boolean(),
		sizeBytes: z.number().int().nonnegative(),
		/** Instances whose volume files the set holds, from the file names. */
		instances: z.array(BackupInstance).max(2000),
		/** The names in the set's plain FAILED file. */
		failedVolumes: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/)).max(4000),
	})
	.strict();
export type HostBackupSet = z.infer<typeof HostBackupSet>;

export const HostBackupDump = z
	.object({
		file: BackupDumpFile,
		sizeBytes: z.number().int().nonnegative(),
		modifiedAt: Timestamp,
	})
	.strict();
export type HostBackupDump = z.infer<typeof HostBackupDump>;

/** The status the host writes back on every channel run. */
export const HostBackupStatus = z
	.object({
		/** The VM's state name, the directory its sets live under. */
		vm: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
		reportedAt: Timestamp,
		nextRunAt: Timestamp.nullable(),
		lastRun: z
			.object({
				startedAt: Timestamp,
				endedAt: Timestamp.nullable(),
				result: z.enum(["success", "failed"]),
			})
			.strict()
			.nullable(),
		lastFailure: z
			.object({ at: Timestamp, reason: z.string().max(300) })
			.strict()
			.nullable(),
		/** A request id, `nightly`, or null when nothing runs. */
		running: z.union([z.string().uuid(), z.literal("nightly")]).nullable(),
		keyInstalled: z.boolean(),
		/** Newest first. */
		sets: z.array(HostBackupSet).max(60),
		dumps: z.array(HostBackupDump).max(200),
	})
	.strict();
export type HostBackupStatus = z.infer<typeof HostBackupStatus>;

/**
 * The document the host sends `portikus backup-channel report` on standard
 * input: the finished request, if any, and the fresh status.
 */
export const BackupChannelReport = z
	.object({
		request: z
			.object({
				id: z.string().uuid(),
				state: z.enum(["done", "failed"]),
				/** One line, shown to the administrator. */
				error: z.string().max(500).nullable(),
				/** For a `backup`, the stamp of the set it made. */
				stamp: BackupStamp.nullable(),
			})
			.strict()
			.nullable(),
		status: HostBackupStatus,
	})
	.strict();
export type BackupChannelReport = z.infer<typeof BackupChannelReport>;

/** What the worker lists from the controller's `GET /volumes/kept`. */
export const BackupVmListing = z
	.object({
		snapshots: z.array(
			z
				.object({
					volume: BackupSnapshotVolume,
					name: BackupSnapshotName,
					createdAt: Timestamp,
				})
				.strict(),
		),
		keptHomes: z.array(
			z
				.object({
					volume: BackupKeptHome,
					instance: BackupInstance,
					createdAt: Timestamp,
				})
				.strict(),
		),
	})
	.strict();
export type BackupVmListing = z.infer<typeof BackupVmListing>;

/** One request row as the admin page sees it. */
export const BackupRequestView = z
	.object({
		id: z.string().uuid(),
		kind: BackupRequestKind,
		args: z.record(z.string(), z.string()),
		state: BackupRequestState,
		requestedAt: Timestamp,
		claimedAt: Timestamp.nullable(),
		finishedAt: Timestamp.nullable(),
		error: z.string().nullable(),
		workspaceId: z.string().uuid().nullable(),
		result: z.unknown().nullable(),
	})
	.strict();
export type BackupRequestView = z.infer<typeof BackupRequestView>;

/** A workspace a set covers, so the page can name it and restore into it. */
export const BackupWorkspace = z
	.object({
		id: z.string().uuid(),
		instance: BackupInstance,
		label: z.string(),
		ownerName: z.string(),
		state: z.string(),
	})
	.strict();
export type BackupWorkspace = z.infer<typeof BackupWorkspace>;

/** `GET /admin/backups`. */
export const AdminBackups = z
	.object({
		/** Null until the host first reports: backups are not connected. */
		host: HostBackupStatus.nullable(),
		hostReportedAt: Timestamp.nullable(),
		hostStale: z.boolean(),
		vm: BackupVmListing.nullable(),
		vmListedAt: Timestamp.nullable(),
		/** Newest first, at most 50. */
		requests: z.array(BackupRequestView),
		workspaces: z.array(BackupWorkspace),
	})
	.strict();
export type AdminBackups = z.infer<typeof AdminBackups>;

/** `POST /admin/backups/restores`. */
export const BackupRestoreRequest = z
	.object({ stamp: BackupStamp, workspaceId: z.string().uuid() })
	.strict();
export type BackupRestoreRequest = z.infer<typeof BackupRestoreRequest>;
