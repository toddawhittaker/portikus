import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import {
	type RecoveryPoint,
	type RecoveryPointList,
	type RecoveryReason,
	RestoreRecoveryPointRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, type Selectable, sql } from "kysely";
import { z } from "zod";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import {
	claimLongOperation,
	ownedProject,
	ownedScope,
	type ProjectRow,
	releaseLongOperation,
	requireAgent,
	sendAgentError,
	sendError,
} from "./project-scope.js";

type RecoveryPointRow = Selectable<Database["recovery_points"]>;

const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });
const PointParam = ProjectParam.extend({ rpid: z.string().uuid() });

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function toRecoveryPoint(row: RecoveryPointRow): RecoveryPoint {
	return {
		id: row.id,
		projectId: row.project_id,
		createdAt: row.created_at.toISOString(),
		reason: row.reason as RecoveryReason,
		sizeBytes: Number(row.size_bytes),
		expiresAt: row.expires_at.toISOString(),
	};
}

/**
 * Ask the agent to archive a project and record the point (SPEC.md §15.2,
 * ADR 0020). Throws the agent's failure so each caller decides whether it
 * is fatal. Only ids and the reason are logged, never a path (SPEC.md §24.8).
 */
export async function makeRecoveryPoint(
	db: Kysely<Database>,
	config: ApiConfig,
	agent: AgentClient,
	input: {
		workspaceId: string;
		project: Pick<ProjectRow, "id" | "slug">;
		reason: RecoveryReason;
		createdBy: string;
		timeoutMs?: number;
	},
): Promise<RecoveryPointRow> {
	const pointId = crypto.randomUUID();
	const created = await agent.createRecoveryPoint(
		input.project.slug,
		{ projectId: input.project.id, pointId },
		input.timeoutMs,
	);
	// No skip fingerprint was sent, so a skip is the agent misbehaving.
	if (!created.created) {
		throw new AgentCallError("AGENT_UNAVAILABLE", "The agent did not make the point.");
	}
	const now = new Date();
	return db
		.insertInto("recovery_points")
		.values({
			id: pointId,
			project_id: input.project.id,
			workspace_id: input.workspaceId,
			reason: input.reason,
			created_at: now.toISOString(),
			created_by: input.createdBy,
			size_bytes: created.sizeBytes,
			sha256: created.sha256,
			fingerprint: created.fingerprint,
			expires_at: new Date(
				now.getTime() + config.RECOVERY_RETENTION_DAYS * DAY_MS,
			).toISOString(),
		})
		.returningAll()
		.executeTakeFirstOrThrow();
}

/**
 * Recovery points of one project (SPEC.md §15). Owner only: an administrator
 * restoring a student's files would be silent impersonation (SPEC.md §20.2),
 * so the one owner check answers 404 to everyone else.
 */
export function registerRecoveryRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	async function scoped(request: FastifyRequest, reply: FastifyReply) {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
			return null;
		}
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return null;
		const project = await ownedProject(db, scope.workspaceId, params.data.pid, reply);
		if (!project) return null;
		return { scope, project };
	}

	// GET .../recovery-points -- works while the workspace is stopped.
	app.get("/workspaces/:id/projects/:pid/recovery-points", async (request, reply) => {
		const found = await scoped(request, reply);
		if (!found) return;
		const { scope, project } = found;

		const rows = await db
			.selectFrom("recovery_points")
			.selectAll()
			.where("project_id", "=", project.id)
			.orderBy("created_at", "desc")
			.execute();
		const used = await db
			.selectFrom("recovery_points")
			.select(sql<string>`coalesce(sum(size_bytes), 0)::text`.as("total"))
			.where("workspace_id", "=", scope.workspaceId)
			.executeTakeFirstOrThrow();
		const workspace = await db
			.selectFrom("workspaces")
			.select("quota_config")
			.where("id", "=", scope.workspaceId)
			.executeTakeFirstOrThrow();
		const recoveryGiB =
			workspace.quota_config?.recoveryGiB ?? config.WORKSPACE_RECOVERY_SIZE_GIB;

		const body: RecoveryPointList = {
			points: rows.map(toRecoveryPoint),
			usage: { usedBytes: Number(used.total), quotaBytes: recoveryGiB * GIB },
		};
		return body;
	});

	// POST .../recovery-points -- "Create recovery point now" (SPEC.md §15.6).
	app.post("/workspaces/:id/projects/:pid/recovery-points", async (request, reply) => {
		const user = requireUser(request);
		const found = await scoped(request, reply);
		if (!found) return;
		const { scope, project } = found;
		const agent = requireAgent(scope, reply);
		if (!agent) return;

		if (!claimLongOperation(scope.workspaceId, reply)) return;
		let row: RecoveryPointRow;
		try {
			row = await makeRecoveryPoint(db, config, agent, {
				workspaceId: scope.workspaceId,
				project,
				reason: "manual",
				createdBy: user.id,
			});
		} catch (error) {
			return sendAgentError(reply, error);
		} finally {
			releaseLongOperation(scope.workspaceId);
		}
		request.log.info(
			{ workspaceId: scope.workspaceId, projectId: project.id, pointId: row.id },
			"recovery point created",
		);
		return reply.status(201).send(toRecoveryPoint(row));
	});

	// POST .../recovery-points/:rpid/restore (SPEC.md §15.8).
	app.post(
		"/workspaces/:id/projects/:pid/recovery-points/:rpid/restore",
		async (request, reply) => {
			const user = requireUser(request);
			const params = PointParam.safeParse(request.params);
			if (!params.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
			}
			const body = RestoreRecoveryPointRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const found = await scoped(request, reply);
			if (!found) return;
			const { scope, project } = found;

			// The point must belong to this project of this workspace.
			const point = await db
				.selectFrom("recovery_points")
				.selectAll()
				.where("id", "=", params.data.rpid)
				.where("project_id", "=", project.id)
				.where("workspace_id", "=", scope.workspaceId)
				.executeTakeFirst();
			if (!point) {
				return sendError(reply, 404, "NOT_FOUND", "Recovery point not found");
			}
			const agent = requireAgent(scope, reply);
			if (!agent) return;

			if (!claimLongOperation(scope.workspaceId, reply)) return;
			try {
				await restore(request, reply, {
					agent,
					userId: user.id,
					workspaceId: scope.workspaceId,
					project,
					point,
					skipSafetyPoint: body.data.skipSafetyPoint === true,
				});
			} finally {
				releaseLongOperation(scope.workspaceId);
			}
		},
	);

	/** The slow half of a restore, so the slot is released on every exit. */
	async function restore(
		request: FastifyRequest,
		reply: FastifyReply,
		input: {
			agent: AgentClient;
			userId: string;
			workspaceId: string;
			project: ProjectRow;
			point: RecoveryPointRow;
			skipSafetyPoint: boolean;
		},
	): Promise<void> {
		const { agent, project, point } = input;

		// The current state is saved first. Only a full allowance may be
		// skipped, and only when the student confirmed it (ADR 0020).
		let safetyPointId: string | null = null;
		try {
			const safety = await makeRecoveryPoint(db, config, agent, {
				workspaceId: input.workspaceId,
				project,
				reason: "before-restore",
				createdBy: input.userId,
			});
			safetyPointId = safety.id;
		} catch (error) {
			const full = error instanceof AgentCallError && error.code === "STORAGE_FULL";
			if (!(full && input.skipSafetyPoint)) {
				request.log.warn(
					{ workspaceId: input.workspaceId, projectId: project.id, full },
					"restore refused: safety point failed",
				);
				return sendAgentError(reply, error);
			}
		}

		let result: "ok" | "failed" = "ok";
		try {
			await agent.restoreRecoveryPoint(project.slug, point.id, {
				projectId: project.id,
				sha256: point.sha256,
			});
		} catch (error) {
			if (!(error instanceof AgentCallError)) throw error;
			result = "failed";
			await auditRestore(request, input, safetyPointId, result);
			return sendAgentError(reply, error);
		}
		await auditRestore(request, input, safetyPointId, result);
		request.log.info(
			{ workspaceId: input.workspaceId, projectId: project.id, pointId: point.id },
			"recovery point restored",
		);
		reply.status(204).send();
	}

	/** Ids and the reason only; never a file name or path (SPEC.md §24.11). */
	async function auditRestore(
		request: FastifyRequest,
		input: { userId: string; project: ProjectRow; point: RecoveryPointRow },
		safetyPointId: string | null,
		result: "ok" | "failed",
	): Promise<void> {
		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${input.userId}`,
				target: input.project.id,
				action: "recovery.restored",
				result,
				metadata: JSON.stringify({
					pointId: input.point.id,
					reason: input.point.reason,
					safetyPointId,
					ip: request.ip,
				}),
			})
			.execute();
	}
}
