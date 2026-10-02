import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminBackups,
	BACKUP_HOST_STALE_SECONDS,
	BackupDumpFile,
	BackupKeptHome,
	type BackupRequestKind,
	type BackupRequestView,
	BackupRestoreRequest,
	BackupSnapshotName,
	BackupSnapshotVolume,
	BackupStamp,
	BackupVmListing,
	HostBackupStatus,
	restoreDirFor,
} from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Selectable } from "kysely";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import {
	claimLongOperation,
	longOperationRunning,
	releaseLongOperation,
} from "../workspaces/long-operation.js";

const adminOnly = { preHandler: requireRole("administrator") };
const RECENT_REQUESTS = 50;

type RequestRow = Selectable<Database["backup_requests"]>;

function toView(row: RequestRow): BackupRequestView {
	return {
		id: row.id,
		kind: row.kind as BackupRequestKind,
		args: (row.args ?? {}) as Record<string, string>,
		state: row.state as BackupRequestView["state"],
		requestedAt: row.requested_at.toISOString(),
		claimedAt: row.claimed_at?.toISOString() ?? null,
		finishedAt: row.finished_at?.toISOString() ?? null,
		error: row.error,
		workspaceId: row.workspace_id,
		result: row.result ?? null,
	};
}

/**
 * Backups from the admin page (SPEC.md §24.9, §24.11; ADR 0024). The API only
 * records requests; the host channel pulls and runs the host kinds, and the
 * worker runs the snapshot and kept-home deletes. Every write is audited.
 */
export function registerAdminBackupRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	async function loadStatus() {
		const row = await db
			.selectFrom("backup_status")
			.selectAll()
			.where("id", "=", 1)
			.executeTakeFirst();
		// A document that does not parse is treated as no report at all.
		const host = HostBackupStatus.safeParse(row?.host);
		const vm = BackupVmListing.safeParse(row?.vm);
		const reportedAt = row?.host_reported_at ?? null;
		const stale =
			!host.success ||
			reportedAt === null ||
			Date.now() - reportedAt.getTime() > BACKUP_HOST_STALE_SECONDS * 1000;
		return {
			host: host.success ? host.data : null,
			hostReportedAt: reportedAt,
			stale,
			vm: vm.success ? vm.data : null,
			vmListedAt: row?.vm_listed_at ?? null,
		};
	}

	/**
	 * Record one request and its audit row together. The same request still
	 * waiting, or a second backup, answers 409.
	 */
	async function record(
		reply: FastifyReply,
		adminId: string,
		kind: BackupRequestKind,
		args: Record<string, string>,
		audit: { action: string; target: string; metadata: Record<string, unknown> },
		workspaceId: string | null = null,
	) {
		const argsJson = JSON.stringify(args);
		const waiting = await db
			.selectFrom("backup_requests")
			.select("id")
			.where("kind", "=", kind)
			.where("state", "in", ["pending", "claimed"])
			.where((eb) => eb("args", "=", eb.cast(eb.val(argsJson), "jsonb")))
			.executeTakeFirst();
		if (waiting) {
			return sendError(
				reply,
				409,
				kind === "backup" ? "BACKUP_RUNNING" : "OPERATION_PENDING",
				kind === "backup"
					? "A backup is already waiting or running."
					: "The same request is already waiting.",
			);
		}
		let row: RequestRow;
		try {
			row = await db.transaction().execute(async (trx) => {
				const inserted = await trx
					.insertInto("backup_requests")
					.values({
						kind,
						args: argsJson,
						requested_by: adminId,
						workspace_id: workspaceId,
					})
					.returningAll()
					.executeTakeFirstOrThrow();
				await recordAudit(trx, {
					actor: `user:${adminId}`,
					target: audit.target,
					action: audit.action,
					result: "ok",
					metadata: { requestId: inserted.id, ...audit.metadata },
				});
				return inserted;
			});
		} catch (error) {
			// Two racing Back up now clicks: the partial unique index keeps one.
			if (kind === "backup" && isUniqueViolation(error)) {
				return sendError(
					reply,
					409,
					"BACKUP_RUNNING",
					"A backup is already waiting or running.",
				);
			}
			throw error;
		}
		return reply.status(202).send(toView(row));
	}

	app.get("/admin/backups", adminOnly, async () => {
		const status = await loadStatus();
		const rows = await db
			.selectFrom("backup_requests")
			.selectAll()
			.orderBy("requested_at", "desc")
			.limit(RECENT_REQUESTS)
			.execute();
		const instances = [...new Set(status.host?.sets.flatMap((s) => s.instances) ?? [])];
		const workspaces =
			instances.length === 0
				? []
				: await db
						.selectFrom("workspaces")
						.innerJoin("users", "users.id", "workspaces.owner_user_id")
						.select([
							"workspaces.id",
							"workspaces.incus_instance_name",
							"workspaces.label",
							"workspaces.state",
							"users.display_name",
						])
						.where("workspaces.incus_instance_name", "in", instances)
						.execute();
		const out: AdminBackups = {
			host: status.host,
			hostReportedAt: status.hostReportedAt?.toISOString() ?? null,
			hostStale: status.stale,
			vm: status.vm,
			vmListedAt: status.vmListedAt?.toISOString() ?? null,
			requests: rows.map(toView),
			workspaces: workspaces.map((w) => ({
				id: w.id,
				instance: w.incus_instance_name as string,
				label: w.label ?? "",
				ownerName: w.display_name,
				state: w.state,
			})),
		};
		return out;
	});

	app.post("/admin/backups/run", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const status = await loadStatus();
		// The host must be listening, or the request would sit unserved.
		if (status.stale) {
			return sendError(
				reply,
				409,
				"BACKUP_HOST_STALE",
				"The host has not reported recently. Wait until it does, then try again.",
			);
		}
		if (status.host?.running === "nightly") {
			return sendError(reply, 409, "BACKUP_RUNNING", "The nightly backup is running.");
		}
		return record(
			reply,
			admin.id,
			"backup",
			{},
			{
				action: "backup.requested",
				target: "backups",
				metadata: {},
			},
		);
	});

	app.delete("/admin/backups/sets/:stamp", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const stamp = BackupStamp.safeParse((request.params as { stamp: string }).stamp);
		if (!stamp.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid set");
		}
		const { host } = await loadStatus();
		const set = host?.sets.find((s) => s.stamp === stamp.data);
		if (!host || !set) return sendError(reply, 404, "NOT_FOUND", "No such backup set");
		// Stamps sort by time, so the newest complete set is the greatest.
		const newest = host.sets
			.filter((s) => s.complete)
			.map((s) => s.stamp)
			.sort()
			.at(-1);
		if (newest === stamp.data) {
			return sendError(
				reply,
				409,
				"BACKUP_NEWEST_SET",
				"The newest complete backup cannot be deleted.",
			);
		}
		return record(
			reply,
			admin.id,
			"delete_set",
			{ stamp: stamp.data },
			{
				action: "backup.set_delete_requested",
				target: stamp.data,
				metadata: { stamp: stamp.data },
			},
		);
	});

	app.delete("/admin/backups/dumps/:file", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const file = BackupDumpFile.safeParse((request.params as { file: string }).file);
		if (!file.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid dump");
		}
		const { host } = await loadStatus();
		if (!host?.dumps.some((d) => d.file === file.data)) {
			return sendError(reply, 404, "NOT_FOUND", "No such dump");
		}
		return record(
			reply,
			admin.id,
			"delete_dump",
			{ file: file.data },
			{
				action: "backup.dump_delete_requested",
				target: file.data,
				metadata: { file: file.data },
			},
		);
	});

	app.post("/admin/backups/restores", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = BackupRestoreRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const { stamp, workspaceId } = body.data;
		const { host } = await loadStatus();
		const set = host?.sets.find((s) => s.stamp === stamp);
		if (!set) return sendError(reply, 404, "NOT_FOUND", "No such backup set");
		const ws = await db
			.selectFrom("workspaces")
			.select(["id", "state", "incus_instance_name"])
			.where("id", "=", workspaceId)
			.executeTakeFirst();
		if (!ws) return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		const instance = ws.incus_instance_name;
		if (!instance || !set.instances.includes(instance)) {
			return sendError(
				reply,
				404,
				"NOT_FOUND",
				"This set does not hold that workspace",
			);
		}
		// The copy is written by the student's account inside the running workspace.
		if (ws.state !== "running") {
			return sendError(
				reply,
				409,
				"WORKSPACE_NOT_RUNNING",
				"Start the workspace first",
			);
		}
		return record(
			reply,
			admin.id,
			"restore_copy",
			{ stamp, instance, dir: restoreDirFor(stamp) },
			{ action: "backup.restore_requested", target: ws.id, metadata: { stamp } },
			ws.id,
		);
	});

	app.post(
		"/admin/backups/restores/:id/replace-home",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = parseOr400(UuidParam, request.params, reply, "invalid restore id");
			if (!params) return;
			const restore = await db
				.selectFrom("backup_requests")
				.selectAll()
				.where("id", "=", params.id)
				.where("kind", "=", "restore_copy")
				.executeTakeFirst();
			if (!restore?.workspace_id) {
				return sendError(reply, 404, "NOT_FOUND", "No such restore");
			}
			// Replace is offered only on a finished side copy.
			if (restore.state !== "done") {
				return sendError(
					reply,
					409,
					"RESTORE_NOT_FINISHED",
					"The side copy has not finished.",
				);
			}
			const workspaceId = restore.workspace_id;
			if (longOperationRunning(workspaceId)) {
				return sendError(
					reply,
					409,
					"OPERATION_IN_PROGRESS",
					"A project operation such as a restore is running on this workspace. Try again when it finishes.",
				);
			}
			// Held while the operation is set, as Rebuild does (ADR 0021).
			claimLongOperation(workspaceId, reply);
			let updated: { numUpdatedRows: bigint };
			try {
				const now = new Date().toISOString();
				updated = await db.transaction().execute(async (trx) => {
					const result = await trx
						.updateTable("workspaces")
						.set({
							pending_operation: "replace-home",
							pending_operation_args: JSON.stringify({ restoreRequestId: restore.id }),
							pending_operation_at: now,
							pending_operation_by: admin.id,
							updated_at: now,
						})
						.where("id", "=", workspaceId)
						.where("pending_operation", "is", null)
						.executeTakeFirst();
					if (result.numUpdatedRows > 0n) {
						await recordAudit(trx, {
							actor: `user:${admin.id}`,
							target: workspaceId,
							action: "workspace.home_replace_requested",
							result: "ok",
							metadata: {
								restoreRequestId: restore.id,
								stamp: (restore.args as { stamp?: string }).stamp ?? null,
							},
						});
					}
					return result;
				});
			} finally {
				releaseLongOperation(workspaceId);
			}
			if (updated.numUpdatedRows === 0n) {
				return sendError(
					reply,
					409,
					"OPERATION_PENDING",
					"Another maintenance operation is already waiting on this workspace.",
				);
			}
			return reply.status(202).send(toView(restore));
		},
	);

	app.delete(
		"/admin/backups/snapshots/:volume/:snapshot",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = request.params as { volume: string; snapshot: string };
			const volume = BackupSnapshotVolume.safeParse(params.volume);
			const snapshot = BackupSnapshotName.safeParse(params.snapshot);
			if (!volume.success || !snapshot.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid snapshot");
			}
			const { vm } = await loadStatus();
			const listed = vm?.snapshots.some(
				(s) => s.volume === volume.data && s.name === snapshot.data,
			);
			if (!listed) return sendError(reply, 404, "NOT_FOUND", "No such snapshot");
			return record(
				reply,
				admin.id,
				"delete_snapshot",
				{ volume: volume.data, snapshot: snapshot.data },
				{
					action: "backup.snapshot_delete_requested",
					target: volume.data,
					metadata: { volume: volume.data, snapshot: snapshot.data },
				},
			);
		},
	);

	app.delete("/admin/backups/kept-homes/:volume", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const volume = BackupKeptHome.safeParse(
			(request.params as { volume: string }).volume,
		);
		if (!volume.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid kept home");
		}
		const { vm } = await loadStatus();
		if (!vm?.keptHomes.some((k) => k.volume === volume.data)) {
			return sendError(reply, 404, "NOT_FOUND", "No such kept home");
		}
		return record(
			reply,
			admin.id,
			"delete_kept_home",
			{ volume: volume.data },
			{
				action: "backup.kept_home_delete_requested",
				target: volume.data,
				metadata: { volume: volume.data },
			},
		);
	});
}
