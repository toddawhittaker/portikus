import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminWorkspaceDetail,
	type AuditEvent,
	allowanceFor,
	type CpuThrottle,
	effectiveGuard,
	type GuardConfig,
	isQuotaGrowOnly,
	type MemoryFlag,
	QUOTA_SHRINK_MESSAGE,
	type QuotaConfig,
	type StorageFigure,
	UpdateGuardRequest,
	UpdateLimitsRequest,
	UpdateQuotaRequest,
	type WorkspaceLimits,
	WorkspaceUsage,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import {
	iso,
	loadHostCpu,
	loadImageFacts,
	toImageVersion,
} from "../admin/workspace-summary.js";
import { type AgentClient, agentClientFor, readJson } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import type { ListeningRegistry } from "../preview/registry.js";
import {
	countActive,
	fromJson,
	loadWorkspaceSettings,
	toWorkspace,
	type WorkspaceRow,
} from "../workspaces/workspace-view.js";

const adminOnly = { preHandler: requireRole("administrator") };

/** How long the detail view waits for the workspace agent. */
const AGENT_PROBE_TIMEOUT_MS = 2000;

/** How many audit rows the detail panel shows. */
const RECENT_AUDIT_LIMIT = 10;

/** The maintenance routes; the admin buttons are on when they are registered. */
const REBUILD_ROUTE = "/admin/workspaces/:id/rebuild";
const RESET_DOCKER_ROUTE = "/workspaces/:id/reset-docker";

/**
 * One `/usage` call: a success means the agent answers, and its sample
 * without the process list is the live usage.
 */
async function probeAgent(agent: AgentClient): Promise<{
	agent: AdminWorkspaceDetail["agent"];
	usage: AdminWorkspaceDetail["usage"];
	storage: AdminWorkspaceDetail["storage"];
}> {
	try {
		const response = await agent.fetchRaw("GET", "/usage", {
			signal: AbortSignal.timeout(AGENT_PROBE_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return { agent: "not_answering", usage: null, storage: null };
		}
		const parsed = WorkspaceUsage.safeParse(await readJson(response));
		if (!parsed.success) return { agent: "answering", usage: null, storage: null };
		// Aggregates only: the process list stays behind (SPEC.md §20.2).
		const { cpuPercent, memory, disk } = parsed.data;
		return {
			agent: "answering",
			usage: { cpuPercent, memory, disk },
			storage: toAdminStorage(parsed.data.storage),
		};
	} catch {
		return { agent: "not_answering", usage: null, storage: null };
	}
}

/** The per-class storage figures, or null unless the agent measured all three. */
function toAdminStorage(
	storage: WorkspaceUsage["storage"],
): AdminWorkspaceDetail["storage"] {
	const { home, docker, recovery } = storage;
	if (!home || !docker || !recovery) return null;
	const use = (figure: StorageFigure) => ({
		usedBytes: figure.usedBytes,
		limitBytes: figure.totalBytes,
	});
	return { home: use(home), docker: use(docker), recovery: use(recovery) };
}

/** The last audit rows about a workspace and its owner, actors resolved. */
async function recentAudit(
	db: Kysely<Database>,
	workspaceId: string,
	ownerId: string,
): Promise<AuditEvent[]> {
	const rows = await db
		.selectFrom("audit_events")
		.leftJoin("users", (join) =>
			join.on(sql`audit_events.actor`, "=", sql`'user:' || users.id::text`),
		)
		.select([
			"audit_events.id",
			"audit_events.at",
			"audit_events.actor",
			"users.display_name",
			"audit_events.action",
			"audit_events.target",
			"audit_events.result",
			"audit_events.metadata",
		])
		.where((eb) =>
			eb.or([
				eb("audit_events.target", "in", [workspaceId, ownerId]),
				eb("audit_events.actor", "=", `user:${ownerId}`),
			]),
		)
		.orderBy("audit_events.id", "desc")
		.limit(RECENT_AUDIT_LIMIT)
		.execute();
	return rows.map((row) => ({
		id: Number(row.id),
		at: new Date(row.at).toISOString(),
		actor: row.actor,
		actorName: row.display_name ?? null,
		action: row.action,
		target: row.target,
		result: row.result,
		metadata: row.metadata,
	}));
}

/**
 * The admin workspace detail, archive and storage routes (SPEC.md §20.1).
 * An administrator sees aggregates and port facts, never contents
 * (SPEC.md §20.2).
 */
export function registerAdminWorkspaceRoutes(
	app: FastifyInstance,
	{ db, config, registry }: ServerDeps & { registry: ListeningRegistry },
): void {
	const defaults: QuotaConfig = {
		homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
		dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
	};

	async function loadRow(id: string): Promise<WorkspaceRow | null> {
		const row = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ?? null;
	}

	app.get("/admin/workspaces/:id", adminOnly, async (request, reply) => {
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const row = await loadRow(id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		const ownerId = row.owner_user_id as string;
		const owner = await db
			.selectFrom("users")
			.select(["id", "display_name", "email", "preferred_username", "disabled_at"])
			.where("id", "=", ownerId)
			.executeTakeFirstOrThrow();

		let agent: AdminWorkspaceDetail["agent"] = "stopped";
		let usage: AdminWorkspaceDetail["usage"] = null;
		let storage: AdminWorkspaceDetail["storage"] = null;
		if (row.state === "running") {
			const client = agentClientFor(row, config.AGENT_PORT);
			agent = "not_answering";
			if (client) ({ agent, usage, storage } = await probeAgent(client));
		}

		const sessions = await db
			.selectFrom("preview_sessions")
			.select(["port", "created_at"])
			.where("workspace_id", "=", id)
			.where("revoked_at", "is", null)
			.orderBy("created_at")
			.execute();

		const settings = await db
			.selectFrom("settings")
			.select([
				"cpu_guard_threshold_percent",
				"memory_guard_threshold_percent",
				"guard_window_minutes",
				"cpu_throttle_share_percent",
				"idle_stop_minutes",
				"cpu_idle_lift_minutes",
				"cpu_idle_lift_percent",
				"keep_running_max_hours",
			])
			.where("id", "=", 1)
			.executeTakeFirst();
		if (!settings) {
			return sendError(reply, 404, "NOT_FOUND", "Platform settings are not set yet");
		}

		const facts = await loadImageFacts(db);
		const body: AdminWorkspaceDetail = {
			workspace: toWorkspace(row, await countActive(db, id, config), config, settings),
			owner: {
				id: owner.id,
				displayName: owner.display_name,
				email: owner.email,
				preferredUsername: owner.preferred_username,
				disabledAt: iso(owner.disabled_at),
			},
			quotaApplied: fromJson<QuotaConfig>(row.quota_applied),
			image: toImageVersion(row.incus_instance_name, row.image_version, facts),
			agent,
			usage,
			storage,
			// Only these four facts: never the command line (SPEC.md §20.2).
			ports: registry.services(id).map((service) => ({
				port: service.port,
				command: service.process?.command ?? null,
				previewReachability: service.previewReachability,
				system: service.system,
			})),
			previewSessions: sessions.map((session) => ({
				port: session.port,
				openedAt: new Date(session.created_at).toISOString(),
			})),
			recentAudit: await recentAudit(db, id, ownerId),
			capabilities: {
				rebuild: app.hasRoute({ method: "POST", url: REBUILD_ROUTE }),
				resetDocker: app.hasRoute({ method: "POST", url: RESET_DOCKER_ROUTE }),
			},
			guardConfig: fromJson<GuardConfig>(row.guard_config),
			effectiveGuard: effectiveGuard(settings, fromJson<GuardConfig>(row.guard_config)),
			cpuThrottle: fromJson<CpuThrottle>(row.cpu_throttle),
			memoryFlag: fromJson<MemoryFlag>(row.memory_flag),
			limitsConfig: fromJson<WorkspaceLimits>(row.limits_config),
			limitsApplied: fromJson<WorkspaceLimits>(row.limits_applied),
		};
		return body;
	});

	/** Archive or unarchive one workspace, with its audit row. */
	async function setArchived(
		request: FastifyRequest,
		reply: FastifyReply,
		archive: boolean,
	): Promise<void> {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const row = await loadRow(id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		const already = (row.archived_at !== null) === archive;
		if (!already) {
			const now = new Date().toISOString();
			// The change and its audit row commit together (SPEC.md §24.11).
			await db.transaction().execute(async (trx) => {
				await trx
					.updateTable("workspaces")
					.set(
						archive
							? { archived_at: now, desired_state: "stopped", updated_at: now }
							: { archived_at: null, updated_at: now },
					)
					.where("id", "=", id)
					.execute();
				await recordAudit(trx, {
					actor: `user:${actor.id}`,
					target: id,
					action: archive ? "workspace.archived" : "workspace.unarchived",
					result: "ok",
				});
			});
		}
		const updated = (await loadRow(id)) as WorkspaceRow;
		reply.send(
			await toWorkspace(
				updated,
				await countActive(db, id, config),
				config,
				await loadWorkspaceSettings(db),
			),
		);
	}

	app.post("/admin/workspaces/:id/archive", adminOnly, async (request, reply) =>
		setArchived(request, reply, true),
	);

	app.post("/admin/workspaces/:id/unarchive", adminOnly, async (request, reply) =>
		setArchived(request, reply, false),
	);

	// Grow home or Docker; the worker applies it.
	app.put("/admin/workspaces/:id/quota", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const body = UpdateQuotaRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const id = params.id;
		const row = await loadRow(id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		if (row.state === "provisioning") {
			return sendError(
				reply,
				409,
				"OPERATION_IN_PROGRESS",
				"This workspace is still being created. Try again in a moment.",
			);
		}
		const stored = fromJson<QuotaConfig>(row.quota_config);
		const from = stored
			? { homeGiB: stored.homeGiB, dockerGiB: stored.dockerGiB }
			: defaults;
		const to = body.data;
		if (!isQuotaGrowOnly(from, to)) {
			return sendError(reply, 400, "VALIDATION_FAILED", QUOTA_SHRINK_MESSAGE);
		}
		if (from.homeGiB !== to.homeGiB || from.dockerGiB !== to.dockerGiB) {
			const now = new Date().toISOString();
			const changed = await db.transaction().execute(async (trx) => {
				// Merge, so other keys (such as recoveryGiB) survive, and land only
				// if nobody changed the sizes since we read them.
				const updated = await trx
					.updateTable("workspaces")
					.set({
						quota_config: sql`coalesce(quota_config, '{}'::jsonb) || ${JSON.stringify(to)}::jsonb`,
						updated_at: now,
					})
					.where("id", "=", id)
					.where(
						stored
							? sql<boolean>`quota_config->'homeGiB' = ${String(from.homeGiB)}::jsonb and quota_config->'dockerGiB' = ${String(from.dockerGiB)}::jsonb`
							: sql<boolean>`quota_config is null`,
					)
					.executeTakeFirst();
				if (Number(updated.numUpdatedRows) === 0) return false;
				await recordAudit(trx, {
					actor: `user:${actor.id}`,
					target: id,
					action: "workspace.quota_updated",
					result: "ok",
					metadata: { from, to },
				});
				return true;
			});
			if (!changed) {
				return sendError(
					reply,
					409,
					"OPERATION_IN_PROGRESS",
					"Another administrator changed this quota. Reload and try again.",
				);
			}
		}
		const updated = (await loadRow(id)) as WorkspaceRow;
		return toWorkspace(
			updated,
			await countActive(db, id, config),
			config,
			await loadWorkspaceSettings(db),
		);
	});
	// Per-workspace guard overrides (ADR 0032).
	app.put("/admin/workspaces/:id/guard", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const body = UpdateGuardRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const id = params.id;
		const found = await db.transaction().execute(async (trx) => {
			// Locked, so two administrators' edits merge rather than overwrite.
			const row = await trx
				.selectFrom("workspaces")
				.select("guard_config")
				.where("id", "=", id)
				.forUpdate()
				.executeTakeFirst();
			if (!row) return false;
			const from: GuardConfig = fromJson<GuardConfig>(row.guard_config) ?? {};
			const to: GuardConfig = { ...from };
			for (const [key, value] of Object.entries(body.data)) {
				if (value === undefined) continue;
				const name = key as keyof GuardConfig;
				if (value === null) delete to[name];
				else to[name] = value;
			}
			if (JSON.stringify(from) === JSON.stringify(to)) return true;
			await trx
				.updateTable("workspaces")
				.set({
					guard_config: Object.keys(to).length > 0 ? JSON.stringify(to) : null,
					updated_at: new Date().toISOString(),
				})
				.where("id", "=", id)
				.execute();
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: id,
				action: "workspace.guard_updated",
				result: "ok",
				metadata: { from, to },
			});
			return true;
		});
		if (!found) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		return reply.status(204).send();
	});

	/**
	 * Lift a throttle or clear a memory flag. The samples go too, so the
	 * workspace gets a full new window before it can be judged again; the
	 * worker removes the allowance on its next tick (ADR 0032).
	 */
	async function clearGuardMark(
		request: FastifyRequest,
		reply: FastifyReply,
		mark: "cpu_throttle" | "memory_flag",
	) {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const outcome = await db.transaction().execute(async (trx) => {
			const cleared = await trx
				.updateTable("workspaces")
				.set({ [mark]: null, updated_at: new Date().toISOString() })
				.where("id", "=", id)
				.where(mark, "is not", null)
				.executeTakeFirst();
			if (Number(cleared.numUpdatedRows) === 0) {
				const exists = await trx
					.selectFrom("workspaces")
					.select("id")
					.where("id", "=", id)
					.executeTakeFirst();
				return exists ? "not_set" : "not_found";
			}
			await trx
				.deleteFrom("workspace_usage_samples")
				.where("workspace_id", "=", id)
				.execute();
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: id,
				action:
					mark === "cpu_throttle"
						? "workspace.cpu_throttle_lifted"
						: "workspace.memory_flag_cleared",
				result: "ok",
				metadata: { reason: "administrator" },
			});
			return "cleared";
		});
		if (outcome === "not_found") {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		if (outcome === "not_set") {
			return mark === "cpu_throttle"
				? sendError(reply, 409, "NOT_THROTTLED", "This workspace is not throttled.")
				: sendError(reply, 409, "NOT_FLAGGED", "This workspace is not flagged.");
		}
		return reply.status(204).send();
	}

	app.post("/admin/workspaces/:id/lift-throttle", adminOnly, async (request, reply) =>
		clearGuardMark(request, reply, "cpu_throttle"),
	);

	app.post(
		"/admin/workspaces/:id/clear-memory-flag",
		adminOnly,
		async (request, reply) => clearGuardMark(request, reply, "memory_flag"),
	);

	/**
	 * Set one workspace's CPU, memory and process limits; null uses the
	 * profile, and the worker applies the change (SPEC.md section 20.1).
	 */
	app.put("/admin/workspaces/:id/limits", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const body = UpdateLimitsRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const id = params.id;
		const host = await loadHostCpu(db);
		if (body.data.cpu !== null && host && body.data.cpu > host.cpuCount) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`This host has only ${host.cpuCount} CPUs.`,
			);
		}
		const to: WorkspaceLimits = {};
		if (body.data.cpu !== null) to.cpu = body.data.cpu;
		if (body.data.memoryMiB !== null) to.memoryMiB = body.data.memoryMiB;
		if (body.data.processes !== null) to.processes = body.data.processes;

		const found = await db.transaction().execute(async (trx) => {
			const row = await trx
				.selectFrom("workspaces")
				.select(["limits_config", "cpu_throttle"])
				.where("id", "=", id)
				.forUpdate()
				.executeTakeFirst();
			if (!row) return false;
			const from: WorkspaceLimits = fromJson<WorkspaceLimits>(row.limits_config) ?? {};
			if (JSON.stringify(from) === JSON.stringify(to)) return true;
			const changes: {
				limits_config: string | null;
				updated_at: string;
				cpu_throttle?: string;
			} = {
				limits_config: Object.keys(to).length > 0 ? JSON.stringify(to) : null,
				updated_at: new Date().toISOString(),
			};
			// A throttle's slice is a share of the CPU count, so it follows the new count.
			const throttle = fromJson<CpuThrottle>(row.cpu_throttle);
			const cpu = to.cpu ?? host?.profileCpu ?? null;
			if (throttle && from.cpu !== to.cpu && cpu !== null) {
				changes.cpu_throttle = JSON.stringify({
					...throttle,
					allowance: allowanceFor(throttle.sharePercent, cpu),
				});
			}
			await trx.updateTable("workspaces").set(changes).where("id", "=", id).execute();
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: id,
				action: "workspace.limits_updated",
				result: "ok",
				metadata: { from, to },
			});
			return true;
		});
		if (!found) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		return reply.status(204).send();
	});

	/**
	 * Send a workspace stuck in `error` back to `provisioning`, so the worker
	 * creates it again. The create adopts an instance and volumes that exist,
	 * so the home survives (SPEC.md section 20.1).
	 */
	app.post("/admin/workspaces/:id/reprovision", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const outcome = await db.transaction().execute(async (trx) => {
			const moved = await trx
				.updateTable("workspaces")
				.set({
					state: "provisioning",
					error_code: null,
					error_message: null,
					// The new instance starts from the profile, so the limits go again.
					limits_applied: null,
					updated_at: new Date().toISOString(),
				})
				.where("id", "=", id)
				.where("state", "=", "error")
				.executeTakeFirst();
			if (Number(moved.numUpdatedRows) === 0) {
				const exists = await trx
					.selectFrom("workspaces")
					.select("id")
					.where("id", "=", id)
					.executeTakeFirst();
				return exists ? "not_in_error" : "not_found";
			}
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: id,
				action: "workspace.reprovision_requested",
				result: "ok",
			});
			return "moved";
		});
		if (outcome === "not_found") {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		if (outcome === "not_in_error") {
			return sendError(
				reply,
				409,
				"NOT_IN_ERROR",
				"Only a workspace in error can be re-provisioned.",
			);
		}
		const updated = (await loadRow(id)) as WorkspaceRow;
		return toWorkspace(
			updated,
			await countActive(db, id, config),
			config,
			await loadWorkspaceSettings(db),
		);
	});
}
