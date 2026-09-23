import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminImageVersion,
	type AdminWorkspaceDetail,
	type AdminWorkspaceSummary,
	type ApiError,
	type AuditEvent,
	HealthSample,
	isQuotaGrowOnly,
	QUOTA_SHRINK_MESSAGE,
	type QuotaConfig,
	type StorageFigure,
	UpdateQuotaRequest,
	WorkspaceUsage,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { type AgentClient, agentClientFor, readJson } from "../agent-client.js";
import type { ListeningRegistry } from "../preview/registry.js";
import type { ServerDeps } from "../server.js";
import { countActive, toWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

const adminOnly = { preHandler: requireRole("administrator") };

/** How long the detail view waits for the workspace agent (Epic 11 brief). */
const AGENT_PROBE_TIMEOUT_MS = 2000;

/** How many audit rows the detail panel shows. */
const RECENT_AUDIT_LIMIT = 10;

/** Epic 10's routes; the admin buttons are on when they are registered. */
const REBUILD_ROUTE = "/admin/workspaces/:id/rebuild";
const RESET_DOCKER_ROUTE = "/workspaces/:id/reset-docker";

function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): void {
	reply.status(statusCode).send({ code, message });
}

/** What the newest health sample says about images, or null without one. */
export interface ImageFacts {
	currentFingerprint: string | null;
	instances: Map<string, { fingerprint: string | null; serial: string | null }>;
}

/** Read the image facts from the newest health sample the worker wrote. */
export async function loadImageFacts(db: Kysely<Database>): Promise<ImageFacts | null> {
	const row = await db
		.selectFrom("health_samples")
		.select("sample")
		.orderBy("observed_at", "desc")
		.orderBy("id", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	const parsed = HealthSample.safeParse(row.sample);
	if (!parsed.success || parsed.data.host === null) return null;
	const host = parsed.data.host;
	return {
		currentFingerprint: host.image.fingerprint,
		instances: new Map(
			host.instances.map((one) => [
				one.name,
				{ fingerprint: one.imageFingerprint, serial: one.imageSerial },
			]),
		),
	};
}

/**
 * The readable image of one instance: its `image.serial`, else the first 12
 * characters of its fingerprint, compared with the current image.
 */
export function toImageVersion(
	instanceName: string | null,
	storedFingerprint: string | null,
	facts: ImageFacts | null,
): AdminImageVersion {
	const seen = instanceName === null ? undefined : facts?.instances.get(instanceName);
	const fingerprint = seen?.fingerprint ?? storedFingerprint;
	const label = seen?.serial ?? (fingerprint ? fingerprint.slice(0, 12) : null);
	const current =
		facts?.currentFingerprint && fingerprint
			? fingerprint === facts.currentFingerprint
			: null;
	return { label, fingerprint, current };
}

/** A jsonb quota column, or null when it is unset. */
function toQuota(value: unknown): QuotaConfig | null {
	if (value === null || value === undefined) return null;
	const raw = typeof value === "string" ? JSON.parse(value) : value;
	return raw as QuotaConfig;
}

function iso(value: unknown): string | null {
	return value ? new Date(value as Date).toISOString() : null;
}

/** One workspace as a row of the admin list shows it. */
export function toWorkspaceSummary(
	row: Record<string, unknown>,
	activeConnections: number,
	facts: ImageFacts | null,
	defaults: QuotaConfig,
): AdminWorkspaceSummary {
	return {
		id: row.id as string,
		label: row.label as string,
		state: row.state as string,
		desiredState: row.desired_state as string,
		activeConnections,
		lastActiveConnectionAt: iso(row.last_active_connection_at),
		quotaConfig: toQuota(row.quota_config) ?? defaults,
		quotaApplied: toQuota(row.quota_applied),
		image: toImageVersion(
			(row.incus_instance_name as string | null) ?? null,
			(row.image_version as string | null) ?? null,
			facts,
		),
		archivedAt: iso(row.archived_at),
	};
}

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

/** Epic 10's per-class figures, or null unless the agent measured all three. */
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

	async function loadRow(id: string): Promise<Record<string, unknown> | null> {
		const row = await db
			.selectFrom("workspaces")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return (row as Record<string, unknown> | undefined) ?? null;
	}

	app.get("/admin/workspaces/:id", adminOnly, async (request, reply) => {
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
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

		const facts = await loadImageFacts(db);
		const body: AdminWorkspaceDetail = {
			workspace: toWorkspace(row, await countActive(db, id, config), config),
			owner: {
				id: owner.id,
				displayName: owner.display_name,
				email: owner.email,
				preferredUsername: owner.preferred_username,
				disabledAt: iso(owner.disabled_at),
			},
			quotaApplied: toQuota(row.quota_applied),
			image: toImageVersion(
				(row.incus_instance_name as string | null) ?? null,
				(row.image_version as string | null) ?? null,
				facts,
			),
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
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
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
				await trx
					.insertInto("audit_events")
					.values({
						actor: `user:${actor.id}`,
						target: id,
						action: archive ? "workspace.archived" : "workspace.unarchived",
						result: "ok",
					})
					.execute();
			});
		}
		const updated = (await loadRow(id)) as Record<string, unknown>;
		reply.send(toWorkspace(updated, await countActive(db, id, config), config));
	}

	app.post("/admin/workspaces/:id/archive", adminOnly, async (request, reply) =>
		setArchived(request, reply, true),
	);

	app.post("/admin/workspaces/:id/unarchive", adminOnly, async (request, reply) =>
		setArchived(request, reply, false),
	);

	// PUT /admin/workspaces/:id/quota -- grow home or Docker; the worker applies it.
	app.put("/admin/workspaces/:id/quota", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const body = UpdateQuotaRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const id = params.data.id;
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
		const stored = toQuota(row.quota_config);
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
				// Merge, so other keys (Epic 10's recoveryGiB) survive, and land only
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
				await trx
					.insertInto("audit_events")
					.values({
						actor: `user:${actor.id}`,
						target: id,
						action: "workspace.quota_updated",
						result: "ok",
						metadata: JSON.stringify({ from, to }),
					})
					.execute();
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
		const updated = (await loadRow(id)) as Record<string, unknown>;
		return toWorkspace(updated, await countActive(db, id, config), config);
	});
}
