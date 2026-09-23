import { requireRole, requireUser } from "@portikus/auth";
import { type PendingOperation, RebuildWorkspaceRequest } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { longOperationRunning, sendError } from "./project-scope.js";
import { findOwnedWorkspace } from "./workspace-view.js";

const UuidParam = z.object({ id: z.string().uuid() });

/**
 * Reset Docker and Rebuild (SPEC.md §16.4, §17.2; ADR 0021). The API only
 * records the operation; the worker, the only writer of `state`, drives it.
 */
export function registerMaintenanceRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	/**
	 * Set the pending operation unless one is already set, and audit the
	 * request. The `is null` guard makes two racing requests safe.
	 */
	async function request(
		reply: FastifyReply,
		userId: string,
		workspaceId: string,
		operation: PendingOperation,
		action: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		// A restore or copy holds the project folders; rebuilding under it would race.
		if (longOperationRunning(workspaceId)) {
			return sendError(
				reply,
				409,
				"OPERATION_IN_PROGRESS",
				"A project operation such as a restore is running on this workspace. Try again when it finishes.",
			);
		}
		const now = new Date().toISOString();
		const updated = await db
			.updateTable("workspaces")
			.set({
				pending_operation: operation,
				pending_operation_at: now,
				pending_operation_by: userId,
				updated_at: now,
			})
			.where("id", "=", workspaceId)
			.where("pending_operation", "is", null)
			.executeTakeFirst();
		if (updated.numUpdatedRows === 0n) {
			return sendError(
				reply,
				409,
				"OPERATION_PENDING",
				"Another maintenance operation is already waiting on this workspace.",
			);
		}
		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${userId}`,
				target: workspaceId,
				action,
				result: "ok",
				metadata: JSON.stringify(metadata),
			})
			.execute();
		reply.status(202).send({ ok: true });
	}

	// POST /workspaces/:id/reset-docker -- the owner or an administrator.
	app.post("/workspaces/:id/reset-docker", async (req, reply) => {
		const user = requireUser(req);
		const params = UuidParam.safeParse(req.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const row = await findOwnedWorkspace(db, user, params.data.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		return request(
			reply,
			user.id,
			params.data.id,
			"reset-docker",
			"workspace.docker_reset_requested",
			{ ip: req.ip },
		);
	});

	// POST /admin/workspaces/:id/rebuild -- administrators only (SPEC.md §17.2).
	app.post(
		"/admin/workspaces/:id/rebuild",
		{ preHandler: requireRole("administrator") },
		async (req, reply) => {
			const user = requireUser(req);
			const params = UuidParam.safeParse(req.params);
			if (!params.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
			}
			const body = RebuildWorkspaceRequest.safeParse(req.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await findOwnedWorkspace(db, user, params.data.id);
			if (!row) {
				return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
			}
			return request(
				reply,
				user.id,
				params.data.id,
				body.data.resetDocker ? "rebuild-reset-docker" : "rebuild",
				"workspace.rebuild_requested",
				{ resetDocker: body.data.resetDocker, ip: req.ip },
			);
		},
	);
}
