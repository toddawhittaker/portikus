import { requireRole, requireUser } from "@portikus/auth";
import { type PendingOperation, RebuildWorkspaceRequest } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import {
	requestPendingOperation,
	sendPendingOperationRefusal,
} from "../workspaces/pending-operation.js";
import { findOwnedWorkspace } from "../workspaces/workspace-view.js";

/**
 * Reset Docker and Rebuild (SPEC.md §16.4, §17.2; ADR 0021). The API only
 * records the operation; the worker, the only writer of `state`, drives it.
 */
export function registerMaintenanceRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	async function request(
		reply: FastifyReply,
		userId: string,
		workspaceId: string,
		operation: PendingOperation,
		action: string,
		metadata: Record<string, unknown>,
	): Promise<FastifyReply> {
		const result = await requestPendingOperation(db, {
			workspaceId,
			userId,
			operation,
			action,
			metadata,
		});
		if (result !== "ok") return sendPendingOperationRefusal(reply, result);
		return reply.status(202).send({ ok: true });
	}

	// The owner or an administrator.
	app.post("/workspaces/:id/reset-docker", async (req, reply) => {
		const user = requireUser(req);
		const params = parseOr400(UuidParam, req.params, reply);
		if (!params) return;
		const row = await findOwnedWorkspace(db, user, params.id);
		if (!row) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		return request(
			reply,
			user.id,
			params.id,
			"reset-docker",
			"workspace.docker_reset_requested",
			{ ip: req.ip },
		);
	});

	// SPEC.md §17.2.
	app.post(
		"/admin/workspaces/:id/rebuild",
		{ preHandler: requireRole("administrator") },
		async (req, reply) => {
			const user = requireUser(req);
			const params = parseOr400(UuidParam, req.params, reply);
			if (!params) return;
			const body = RebuildWorkspaceRequest.safeParse(req.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			const row = await findOwnedWorkspace(db, user, params.id);
			if (!row) {
				return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
			}
			return request(
				reply,
				user.id,
				params.id,
				body.data.resetDocker ? "rebuild-reset-docker" : "rebuild",
				"workspace.rebuild_requested",
				{ resetDocker: body.data.resetDocker, ip: req.ip },
			);
		},
	);
}
