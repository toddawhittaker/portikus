import {
	BACKUP_REPORT_MAX_BYTES,
	BackupChannelReport,
	BackupChannelRequest,
	BackupHostKind,
	BackupRequestArgs,
	BackupVmListing,
	HostBackupStatus,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql, type Transaction } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";

/**
 * The VM half of the backup channel and the VM-side backup work (SPEC.md §24.9;
 * ADR 0024, ADR 0040). The host pulls one request at a time over SSH and
 * reports back; everything it sends is checked here before it is stored.
 */

/** A claimed host request older than this, with the host running nothing, failed. */
export const BACKUP_CLAIM_TIMEOUT_MS = 15 * 60_000;

/** How often the worker runs the VM-side deletes. */
export const BACKUP_VM_LOOP_SECONDS = 30;

/** How often the worker lists kept volumes, which costs Incus calls per workspace; also right after a delete. */
export const BACKUP_VM_LIST_SECONDS = 300;

const HOST_KINDS: readonly string[] = BackupHostKind.options;
const VM_KINDS = ["delete_snapshot", "delete_kept_home"] as const;

type Db = Kysely<Database> | Transaction<Database>;

/** Actions of the outcome audit rows the host's report writes, by kind. */
const OUTCOME_ACTIONS: Record<string, { done: string; failed: string }> = {
	backup: { done: "backup.completed", failed: "backup.failed" },
	delete_set: { done: "backup.set_deleted", failed: "backup.set_delete_failed" },
	delete_dump: { done: "backup.dump_deleted", failed: "backup.dump_delete_failed" },
	restore_copy: { done: "backup.restore_copied", failed: "backup.restore_failed" },
	import_home: { done: "backup.home_imported", failed: "backup.home_import_failed" },
	delete_snapshot: {
		done: "backup.snapshot_deleted",
		failed: "backup.snapshot_delete_failed",
	},
	delete_kept_home: {
		done: "backup.kept_home_deleted",
		failed: "backup.kept_home_delete_failed",
	},
};

async function audit(
	db: Db,
	actor: string,
	target: string,
	action: string,
	result: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await db
		.insertInto("audit_events")
		.values({ actor, target, action, result, metadata: JSON.stringify(metadata) })
		.execute();
}

/** The same target the request's own audit row used, so the two pair up. */
function auditTarget(row: {
	kind: string;
	args: unknown;
	workspace_id: string | null;
}): string {
	const args = (row.args ?? {}) as Record<string, string>;
	if (row.workspace_id) return row.workspace_id;
	return args.stamp ?? args.file ?? args.volume ?? "backups";
}

async function notifyOwner(
	db: Db,
	workspaceId: string,
	tone: string,
	title: string,
	body: string,
): Promise<void> {
	const ws = await db
		.selectFrom("workspaces")
		.select("owner_user_id")
		.where("id", "=", workspaceId)
		.executeTakeFirst();
	if (!ws) return;
	await db
		.insertInto("notifications")
		.values({ user_id: ws.owner_user_id, tone, title, body })
		.execute();
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** `20260924T023000Z` reads as "24 September 2026, 02:30", the set's UTC time. */
export function describeStamp(stamp: string): string {
	const day = Number(stamp.slice(6, 8));
	const month = MONTHS[Number(stamp.slice(4, 6)) - 1];
	return `${day} ${month} ${stamp.slice(0, 4)}, ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}`;
}

/** Drop the presence row a side copy held, so the grace period applies again. */
async function releasePresence(db: Db, result: unknown): Promise<void> {
	const connectionId = (result as { connectionId?: unknown } | null)?.connectionId;
	if (typeof connectionId !== "string") return;
	await db.deleteFrom("workspace_connections").where("id", "=", connectionId).execute();
}

/** Finish a request the host ran, with its audit row and any notification. */
async function finishHostRequest(
	db: Db,
	row: {
		id: string;
		kind: string;
		args: unknown;
		workspace_id: string | null;
		result: unknown;
	},
	outcome: { state: "done" | "failed"; error: string | null; stamp: string | null },
	now: Date,
): Promise<void> {
	await releasePresence(db, row.result);
	await db
		.updateTable("backup_requests")
		.set({
			state: outcome.state,
			finished_at: now.toISOString(),
			error: outcome.state === "failed" ? (outcome.error ?? "failed") : null,
			result: outcome.stamp ? JSON.stringify({ stamp: outcome.stamp }) : null,
		})
		.where("id", "=", row.id)
		.execute();
	const actions = OUTCOME_ACTIONS[row.kind];
	if (actions) {
		await audit(
			db,
			"host",
			auditTarget(row),
			outcome.state === "done" ? actions.done : actions.failed,
			outcome.state === "done" ? "ok" : "failed",
			{
				requestId: row.id,
				...(outcome.stamp ? { stamp: outcome.stamp } : {}),
				...(outcome.state === "failed" ? { error: outcome.error } : {}),
			},
		);
	}
	const args = (row.args ?? {}) as { stamp?: string; dir?: string };
	if (
		row.kind === "restore_copy" &&
		outcome.state === "done" &&
		row.workspace_id &&
		args.stamp &&
		args.dir
	) {
		await notifyOwner(
			db,
			row.workspace_id,
			"success",
			"A copy of your files was restored",
			`An administrator restored a copy of your files from ${describeStamp(args.stamp)} into ~/${args.dir}.`,
		);
	}
}

/**
 * `portikus backup-channel pull`: fail requests the host lost, then claim the
 * oldest pending host request and return it, or null. At most one is claimed.
 */
export async function pullRequest(
	db: Kysely<Database>,
	now: Date,
): Promise<BackupChannelRequest | null> {
	return db.transaction().execute(async (trx) => {
		const status = await trx
			.selectFrom("backup_status")
			.select("host")
			.where("id", "=", 1)
			.executeTakeFirst();
		const parsed = HostBackupStatus.safeParse(status?.host);
		const running = parsed.success ? parsed.data.running : null;
		const stale = await trx
			.selectFrom("backup_requests")
			.select(["id", "kind", "args", "workspace_id", "result"])
			.where("state", "=", "claimed")
			.where("kind", "in", HOST_KINDS)
			.where("claimed_at", "<", new Date(now.getTime() - BACKUP_CLAIM_TIMEOUT_MS))
			.forUpdate()
			.execute();
		for (const row of stale) {
			if (row.id === running) continue;
			await finishHostRequest(
				trx,
				row,
				{ state: "failed", error: "interrupted", stamp: null },
				now,
			);
		}

		const next = await trx
			.selectFrom("backup_requests")
			.select(["id", "kind", "args", "workspace_id"])
			.where("state", "=", "pending")
			.where("kind", "in", HOST_KINDS)
			.orderBy("requested_at", "asc")
			.orderBy("id", "asc")
			.limit(1)
			.forUpdate()
			.skipLocked()
			.executeTakeFirst();
		if (!next) return null;

		const request = BackupChannelRequest.safeParse({
			id: next.id,
			kind: next.kind,
			args: next.args,
		});
		if (!request.success) {
			// Never hand the host something the API should not have stored.
			await finishHostRequest(
				trx,
				{ ...next, result: null },
				{ state: "failed", error: "invalid request", stamp: null },
				now,
			);
			return null;
		}

		let result: string | null = null;
		if (request.data.kind === "restore_copy" && next.workspace_id) {
			// Hold the workspace like a browser does, so the grace period cannot stop it.
			const conn = await trx
				.insertInto("workspace_connections")
				.values({ workspace_id: next.workspace_id, last_seen_at: now.toISOString() })
				.returning("id")
				.executeTakeFirstOrThrow();
			result = JSON.stringify({ connectionId: conn.id });
		}
		await trx
			.updateTable("backup_requests")
			.set({ state: "claimed", claimed_at: now.toISOString(), result })
			.where("id", "=", next.id)
			.execute();
		return request.data;
	});
}

export type ReportOutcome =
	| { ok: true; warning: string | null }
	| { ok: false; error: string };

/**
 * `portikus backup-channel report`: check the host's document, store its
 * status whole, and finish the request it names if that request is claimed.
 */
export async function acceptReport(
	db: Kysely<Database>,
	input: Buffer,
	now: Date,
): Promise<ReportOutcome> {
	if (input.length > BACKUP_REPORT_MAX_BYTES) {
		return {
			ok: false,
			error: `the report is larger than ${BACKUP_REPORT_MAX_BYTES} bytes`,
		};
	}
	let json: unknown;
	try {
		json = JSON.parse(input.toString("utf8"));
	} catch {
		return { ok: false, error: "the report is not JSON" };
	}
	const parsed = BackupChannelReport.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			error: `the report does not match the schema at ${issue?.path.join(".") || "(root)"}`,
		};
	}
	const report = parsed.data;
	return db.transaction().execute(async (trx) => {
		await trx
			.updateTable("backup_status")
			.set({
				host: JSON.stringify(report.status),
				host_reported_at: now.toISOString(),
			})
			.where("id", "=", 1)
			.execute();
		if (!report.request) return { ok: true, warning: null };
		const row = await trx
			.selectFrom("backup_requests")
			.select(["id", "kind", "args", "workspace_id", "result", "state"])
			.where("id", "=", report.request.id)
			.forUpdate()
			.executeTakeFirst();
		if (row?.state !== "claimed" || !HOST_KINDS.includes(row.kind)) {
			return {
				ok: true,
				warning: `request ${report.request.id} is not a claimed host request; its result was ignored`,
			};
		}
		await finishHostRequest(
			trx,
			row,
			{
				state: report.request.state,
				error: report.request.error,
				stamp: row.kind === "backup" ? report.request.stamp : null,
			},
			now,
		);
		return { ok: true, warning: null };
	});
}

/** Keep side copies' presence rows fresh while the host runs them. */
export async function refreshRestorePresence(
	db: Kysely<Database>,
	now: Date,
): Promise<void> {
	await db
		.updateTable("workspace_connections")
		.set({ last_seen_at: now.toISOString() })
		.where(
			"id",
			"in",
			db
				.selectFrom("backup_requests")
				.select(sql<string>`(result->>'connectionId')::uuid`.as("id"))
				.where("kind", "=", "restore_copy")
				.where("state", "=", "claimed")
				.where(sql<boolean>`result ? 'connectionId'`),
		)
		.execute();
}

/**
 * Run the snapshot and kept-home deletes through the controller, one at a
 * time. A claimed one left by a worker that died is run again: a delete of
 * something already gone counts as done.
 */
export async function runVmDeletes(
	db: Kysely<Database>,
	controller: ControllerClient,
	now: () => Date,
): Promise<number> {
	const rows = await db
		.selectFrom("backup_requests")
		.select(["id", "kind", "args", "workspace_id"])
		.where("kind", "in", VM_KINDS)
		.where("state", "in", ["pending", "claimed"])
		.orderBy("requested_at", "asc")
		.execute();
	for (const row of rows) {
		await db
			.updateTable("backup_requests")
			.set({ state: "claimed", claimed_at: now().toISOString() })
			.where("id", "=", row.id)
			.execute();
		let error: string | null = null;
		try {
			if (row.kind === "delete_snapshot") {
				const args = BackupRequestArgs.delete_snapshot.parse(row.args);
				await controller.deleteSnapshot(args.volume, args.snapshot);
			} else {
				const args = BackupRequestArgs.delete_kept_home.parse(row.args);
				await controller.deleteKeptHome(args.volume);
			}
		} catch (e) {
			const gone = e instanceof ControllerClientError && e.code === "NOT_FOUND";
			if (!gone) error = e instanceof Error ? e.message.slice(0, 300) : String(e);
		}
		const actions = OUTCOME_ACTIONS[row.kind] as { done: string; failed: string };
		await db.transaction().execute(async (trx) => {
			await trx
				.updateTable("backup_requests")
				.set({
					state: error ? "failed" : "done",
					finished_at: now().toISOString(),
					error,
				})
				.where("id", "=", row.id)
				.execute();
			await audit(
				trx,
				"worker",
				auditTarget(row),
				error ? actions.failed : actions.done,
				error ? "failed" : "ok",
				{ requestId: row.id, ...(row.args as object), ...(error ? { error } : {}) },
			);
		});
	}
	return rows.length;
}

/** List pre-change snapshots and kept homes into `backup_status.vm`. */
export async function listVmVolumes(
	db: Kysely<Database>,
	controller: ControllerClient,
	now: Date,
): Promise<void> {
	const listing = BackupVmListing.parse(await controller.keptVolumes());
	await db
		.updateTable("backup_status")
		.set({ vm: JSON.stringify(listing), vm_listed_at: now.toISOString() })
		.where("id", "=", 1)
		.execute();
}

/** One pass of the VM loop; errors are logged, never thrown. */
export async function backupVmTick(options: {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}): Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	try {
		await refreshRestorePresence(db, now());
		const ran = await runVmDeletes(db, controller, now);
		if (ran > 0) logger.info({ deletes: ran }, "backup deletes run");
		const status = await db
			.selectFrom("backup_status")
			.select("vm_listed_at")
			.where("id", "=", 1)
			.executeTakeFirst();
		const listedAt = status?.vm_listed_at?.getTime() ?? null;
		const due =
			listedAt === null || now().getTime() - listedAt >= BACKUP_VM_LIST_SECONDS * 1000;
		if (ran > 0 || due) await listVmVolumes(db, controller, now());
	} catch (e) {
		logger.error(
			{ error: e instanceof Error ? e.message : String(e) },
			"backup volume loop error",
		);
	}
}

/** Run the VM loop now and every BACKUP_VM_LOOP_SECONDS; returns a stop function. */
export function startBackupVmLoop(options: {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
}): () => void {
	const timer = setInterval(() => {
		void backupVmTick(options);
	}, BACKUP_VM_LOOP_SECONDS * 1000);
	timer.unref();
	void backupVmTick(options);
	return () => clearInterval(timer);
}

/** What the student sees when a replace fails after the home was touched. */
const REPLACE_FAILED_MESSAGE =
	"Your home folder could not be replaced. Please contact your administrator.";

/**
 * One step of a pending `replace-home` on a stopped or errored workspace
 * (SPEC.md §17.2, §24.9; ADR 0021, ADR 0040). The first call records an
 * `import_home` request for the host; later calls wait for it, then have the
 * controller swap the volumes. Returns 1 when the row changed state.
 */
export async function runReplaceHome(
	db: Kysely<Database>,
	controller: ControllerClient,
	ws: {
		id: string;
		instance: string;
		state: string;
		pendingAt: Date | null;
		pendingBy: string | null;
		args: unknown;
	},
	now: Date,
): Promise<number> {
	const args = (ws.args ?? {}) as {
		restoreRequestId?: string;
		importRequestId?: string;
	};
	const restore = args.restoreRequestId
		? await db
				.selectFrom("backup_requests")
				.select(["id", "args"])
				.where("id", "=", args.restoreRequestId)
				.where("kind", "=", "restore_copy")
				.executeTakeFirst()
		: undefined;
	const stamp = (restore?.args as { stamp?: string } | undefined)?.stamp;
	const base = {
		restoreRequestId: args.restoreRequestId ?? null,
		stamp: stamp ?? null,
	};

	const finish = async (
		outcome: { kept: string } | { error: string; homeTouched: boolean },
	): Promise<number> => {
		const failed = "error" in outcome;
		// Only a swap that may have begun leaves the workspace in error.
		const touched = failed && outcome.homeTouched;
		const nextState = !failed ? "stopped" : touched ? "error" : ws.state;
		return db.transaction().execute(async (trx) => {
			const updated = await trx
				.updateTable("workspaces")
				.set({
					pending_operation: null,
					pending_operation_args: null,
					pending_operation_at: null,
					pending_operation_by: null,
					state: nextState,
					...(!failed ? { error_code: null, error_message: null } : {}),
					...(touched
						? { error_code: "OPERATION_FAILED", error_message: REPLACE_FAILED_MESSAGE }
						: {}),
					updated_at: now.toISOString(),
				})
				.where("id", "=", ws.id)
				.where("pending_operation", "=", "replace-home")
				.executeTakeFirst();
			if (updated.numUpdatedRows === 0n) return 0;
			await audit(
				trx,
				"worker",
				ws.id,
				failed ? "workspace.home_replace_failed" : "workspace.home_replaced",
				failed ? "failed" : "ok",
				{
					...base,
					requestedBy: ws.pendingBy,
					...(failed ? { error: outcome.error } : { kept: outcome.kept }),
				},
			);
			const when = stamp ? ` from ${describeStamp(stamp)}` : "";
			await notifyOwner(
				trx,
				ws.id,
				failed ? "danger" : "success",
				failed ? "Your home folder was not replaced" : "Your home folder was replaced",
				failed
					? touched
						? REPLACE_FAILED_MESSAGE
						: `An administrator tried to replace your home folder with the backup${when}, but it did not work. Your files are unchanged.`
					: `An administrator replaced your home folder with the backup${when}. Your previous home folder is kept, and your projects have recovery points from just before.`,
			);
			return nextState !== ws.state ? 1 : 0;
		});
	};

	if (!restore || !stamp) {
		return finish({ error: "the restore request is missing", homeTouched: false });
	}

	if (!args.importRequestId) {
		const importArgs = BackupRequestArgs.import_home.parse({
			stamp,
			instance: ws.instance,
		});
		await db.transaction().execute(async (trx) => {
			const inserted = await trx
				.insertInto("backup_requests")
				.values({
					kind: "import_home",
					args: JSON.stringify(importArgs),
					requested_by: ws.pendingBy,
					workspace_id: ws.id,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			await trx
				.updateTable("workspaces")
				.set({
					pending_operation_args: JSON.stringify({
						...args,
						importRequestId: inserted.id,
					}),
				})
				.where("id", "=", ws.id)
				.where("pending_operation", "=", "replace-home")
				.execute();
		});
		return 0;
	}

	const imported = await db
		.selectFrom("backup_requests")
		.select(["state", "error"])
		.where("id", "=", args.importRequestId)
		.executeTakeFirst();
	if (!imported) {
		return finish({ error: "the import request is missing", homeTouched: false });
	}
	if (imported.state === "pending" || imported.state === "claimed") return 0;
	if (imported.state === "failed") {
		return finish({
			error: `the host could not import the home: ${imported.error ?? "failed"}`,
			homeTouched: false,
		});
	}

	try {
		const { kept } = await controller.replaceHome(ws.instance);
		return finish({ kept });
	} catch (e) {
		const err =
			e instanceof ControllerClientError
				? e
				: new ControllerClientError("OPERATION_FAILED", String(e));
		// Unreachable or slow: the next sweep repeats the swap, which is safe.
		if (err.code === "INCUS_UNAVAILABLE" || err.code === "TIMEOUT") return 0;
		if (err.code === "NOT_FOUND") {
			// A retry after a finished swap: the import is gone, the kept home is there.
			let kept: string | null;
			try {
				kept = await keptSince(controller, ws.instance, ws.pendingAt);
			} catch {
				return 0;
			}
			if (kept) return finish({ kept });
			// The controller refuses before it touches anything when the import is missing.
			return finish({ error: err.message.slice(0, 300), homeTouched: false });
		}
		return finish({ error: err.message.slice(0, 300), homeTouched: true });
	}
}

/** The kept home this operation made, named with a time at or after it began. */
async function keptSince(
	controller: ControllerClient,
	instance: string,
	since: Date | null,
): Promise<string | null> {
	const { keptHomes } = await controller.keptVolumes();
	const floor = since ? Math.floor(since.getTime() / 1000) : 0;
	const mine = keptHomes
		.filter((k) => k.instance === instance)
		.map((k) => ({ volume: k.volume, at: Number(k.volume.split("-").at(-1)) }))
		.filter((k) => k.at >= floor)
		.sort((a, b) => b.at - a.at);
	return mine[0]?.volume ?? null;
}
