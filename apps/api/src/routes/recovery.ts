import { requireUser } from "@portikus/auth";
import {
	type AgentRecoveryDiffQuery,
	GitDiff,
	ProjectPath,
	RECOVERY_DIFF_TIMEOUT_MS,
	type RecoveryPoint,
	type RecoveryPointList,
	type RecoveryReason,
	RestoreRecoveryPointRequest,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
	AGENT_TIMEOUT_MS,
	AgentCallError,
	type AgentClient,
	readAgentError,
	readJson,
} from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import {
	claimLongOperation,
	releaseLongOperation,
} from "../workspaces/long-operation.js";
import {
	agentUrl,
	ownedProject,
	ownedScope,
	type ProjectRow,
	requireAgent,
	sendAgentError,
} from "../workspaces/project-scope.js";
import {
	countProjectPoints,
	MAX_POINTS_PER_PROJECT,
	makeRecoveryPoint,
	type RecoveryPointRow,
} from "../workspaces/recovery-points.js";

const PointParam = ProjectParam.extend({ rpid: z.string().uuid() });

const GIB = 1024 ** 3;
/** The agent's read budget plus the time a healthy agent needs to answer. */
const DIFF_BUDGET_MS = RECOVERY_DIFF_TIMEOUT_MS + AGENT_TIMEOUT_MS;
/** At most one manual point per project this often. */
const MANUAL_POINT_INTERVAL_MS = 30_000;
/** Workspaces with a point diff in flight; per API process, like long-operation.ts. */
const diffsRunning = new Set<string>();

/** Answer 409 while a maintenance operation waits on the workspace. */
async function refusePending(
	db: Kysely<Database>,
	workspaceId: string,
	reply: FastifyReply,
): Promise<boolean> {
	const row = await db
		.selectFrom("workspaces")
		.select("pending_operation")
		.where("id", "=", workspaceId)
		.executeTakeFirst();
	if (!row?.pending_operation) return false;
	sendError(
		reply,
		409,
		"OPERATION_PENDING",
		"A maintenance operation is waiting on this workspace. Try again when it is done.",
	);
	return true;
}

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

	/**
	 * The point, only when it belongs to this project of this workspace;
	 * otherwise answers 404 and returns null.
	 */
	async function ownedPoint(
		pointId: string,
		projectId: string,
		workspaceId: string,
		reply: FastifyReply,
	): Promise<RecoveryPointRow | null> {
		const point = await db
			.selectFrom("recovery_points")
			.selectAll()
			.where("id", "=", pointId)
			.where("project_id", "=", projectId)
			.where("workspace_id", "=", workspaceId)
			.executeTakeFirst();
		if (!point) {
			sendError(reply, 404, "NOT_FOUND", "Recovery point not found");
			return null;
		}
		return point;
	}

	// Works while the workspace is stopped.
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

	// "Create recovery point now" (SPEC.md §15.6).
	app.post("/workspaces/:id/projects/:pid/recovery-points", async (request, reply) => {
		const user = requireUser(request);
		const found = await scoped(request, reply);
		if (!found) return;
		const { scope, project } = found;
		const agent = requireAgent(scope, reply);
		if (!agent) return;
		// Claimed before the pending check, so a maintenance request cannot slip
		// in between them (it holds the same slot while it sets its operation).
		if (!claimLongOperation(scope.workspaceId, reply)) return;
		let row: RecoveryPointRow;
		try {
			if (await refusePending(db, scope.workspaceId, reply)) return;
			const latest = await db
				.selectFrom("recovery_points")
				.select("created_at")
				.where("project_id", "=", project.id)
				.where("reason", "=", "manual")
				.orderBy("created_at", "desc")
				.limit(1)
				.executeTakeFirst();
			if (
				latest &&
				Date.now() - latest.created_at.getTime() < MANUAL_POINT_INTERVAL_MS
			) {
				return sendError(
					reply,
					429,
					"RATE_LIMITED",
					"A recovery point was made moments ago. Wait 30 seconds and try again.",
				);
			}
			if ((await countProjectPoints(db, project.id)) >= MAX_POINTS_PER_PROJECT) {
				return sendError(
					reply,
					409,
					"BUSY",
					`This project already has ${MAX_POINTS_PER_PROJECT} recovery points, the most it can keep. Older points expire on their own; try again later.`,
				);
			}

			try {
				row = await makeRecoveryPoint(db, config, agent, {
					workspaceId: scope.workspaceId,
					project,
					reason: "manual",
					createdBy: user.id,
				});
			} catch (error) {
				return sendAgentError(reply, error);
			}
		} finally {
			releaseLongOperation(scope.workspaceId);
		}
		request.log.info(
			{ workspaceId: scope.workspaceId, projectId: project.id, pointId: row.id },
			"recovery point created",
		);
		return reply.status(201).send(toRecoveryPoint(row));
	});

	// SPEC.md §15.8.
	app.post(
		"/workspaces/:id/projects/:pid/recovery-points/:rpid/restore",
		async (request, reply) => {
			const user = requireUser(request);
			const params = parseOr400(PointParam, request.params, reply);
			if (!params) return;
			const body = RestoreRecoveryPointRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const found = await scoped(request, reply);
			if (!found) return;
			const { scope, project } = found;

			const point = await ownedPoint(params.rpid, project.id, scope.workspaceId, reply);
			if (!point) return;
			const agent = requireAgent(scope, reply);
			if (!agent) return;
			// Claimed before the pending check; see the create route.
			if (!claimLongOperation(scope.workspaceId, reply)) return;
			try {
				if (await refusePending(db, scope.workspaceId, reply)) return;
				return await restore(request, reply, {
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

	// One file of a point against its working copy (SPEC.md §15.8, §12.6).
	// Read-only, so it neither claims the long-operation slot nor waits on
	// a pending one.
	app.get(
		"/workspaces/:id/projects/:pid/recovery-points/:rpid/diff",
		async (request, reply) => {
			const params = parseOr400(PointParam, request.params, reply);
			if (!params) return;
			const found = await scoped(request, reply);
			if (!found) return;
			const { scope, project } = found;
			// Checked here as well as in the agent, so a traversal attempt
			// never leaves the control plane (SPEC.md §24.6).
			const path = ProjectPath.safeParse((request.query as { path?: unknown })?.path);
			if (!path.success) {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"that path is not inside the project",
				);
			}
			const point = await ownedPoint(params.rpid, project.id, scope.workspaceId, reply);
			if (!point) return;
			const agent = requireAgent(scope, reply);
			if (!agent) return;

			// Each point diff reads a whole archive; one at a time per workspace
			// keeps a student's clicks from stacking those reads (SPEC.md §15.8).
			if (diffsRunning.has(scope.workspaceId)) {
				return sendError(
					reply,
					429,
					"RATE_LIMITED",
					"Another comparison with a recovery point is still running. Try again when it finishes.",
				);
			}
			diffsRunning.add(scope.workspaceId);
			// A browser that gives up stops the agent's read too.
			const disconnected = new AbortController();
			const onClose = () => disconnected.abort();
			request.raw.on("close", onClose);
			try {
				return await pointDiff(request, reply, {
					agent,
					slug: project.slug,
					pointId: point.id,
					query: {
						projectId: project.id,
						path: path.data,
						sha256: point.sha256,
					},
					signal: AbortSignal.any([
						disconnected.signal,
						AbortSignal.timeout(DIFF_BUDGET_MS),
					]),
				});
			} finally {
				request.raw.off("close", onClose);
				diffsRunning.delete(scope.workspaceId);
			}
		},
	);

	/** Relay one point diff from the agent and check its answer. */
	async function pointDiff(
		request: FastifyRequest,
		reply: FastifyReply,
		input: {
			agent: AgentClient;
			slug: string;
			pointId: string;
			query: AgentRecoveryDiffQuery;
			signal: AbortSignal;
		},
	): Promise<GitDiff | FastifyReply> {
		let response: Response;
		try {
			response = await input.agent.fetchRaw(
				"GET",
				agentUrl(input.slug, `recovery-points/${input.pointId}/diff`, input.query),
				{ signal: input.signal },
			);
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) {
			const failure = await readAgentError(response);
			if (failure.code === "RECOVERY_READ_TIMEOUT") {
				return sendError(
					reply,
					504,
					"RECOVERY_READ_TIMEOUT",
					"Reading this file from the recovery point took too long. Try again, or restore the point to see it.",
				);
			}
			return sendAgentError(reply, failure);
		}
		const parsed = GitDiff.safeParse(await readJson(response));
		if (!parsed.success) {
			// Only where the answer went wrong; the values are student content.
			request.log.error(
				{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
				"the workspace agent sent an answer the contract rejected",
			);
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent sent an answer we could not read.",
			);
		}
		return parsed.data;
	}

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
	): Promise<FastifyReply | undefined> {
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
			// STORAGE_FULL here is the home folder, not recovery storage, so the
			// browser must not offer to skip the safety point.
			if (error.code === "STORAGE_FULL") {
				return sendError(
					reply,
					500,
					"INTERNAL",
					"Your home folder is full, so nothing was restored. Free some space and try again.",
				);
			}
			if (error.code === "ROLLBACK_COPY_EXISTS") {
				return sendError(
					reply,
					409,
					"BUSY",
					`Files set aside by an earlier restore of this point are in the folder ~/projects/.portikus-aside-${point.id}. Copy back anything you need, delete that folder in a terminal, then restore again. You can restore a different point in the meantime.`,
				);
			}
			if (error.code === "RESTORE_INCOMPLETE" && safetyPointId === null) {
				return sendError(
					reply,
					500,
					"INTERNAL",
					`The project may be partly restored. Your earlier files are kept in a folder named .portikus-aside-${point.id} in the projects folder; do not delete it.`,
				);
			}
			return sendAgentError(reply, error);
		}
		await auditRestore(request, input, safetyPointId, result);
		request.log.info(
			{ workspaceId: input.workspaceId, projectId: project.id, pointId: point.id },
			"recovery point restored",
		);
		return reply.status(204).send();
	}

	/** Ids and the reason only; never a file name or path (SPEC.md §24.11). */
	async function auditRestore(
		request: FastifyRequest,
		input: { userId: string; project: ProjectRow; point: RecoveryPointRow },
		safetyPointId: string | null,
		result: "ok" | "failed",
	): Promise<void> {
		await recordAudit(db, {
			actor: `user:${input.userId}`,
			target: input.project.id,
			action: "recovery.restored",
			result,
			metadata: {
				pointId: input.point.id,
				reason: input.point.reason,
				safetyPointId,
				ip: request.ip,
			},
		});
	}
}
