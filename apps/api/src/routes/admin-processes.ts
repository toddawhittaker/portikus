import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminProcessSnapshot,
	InstanceProcess,
	ProcessStopErrorCode,
	ProcessStopRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentCallError, agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { recordNotification } from "./notifications.js";
import { REFUSAL_STATUS, refusalMessage } from "./processes.js";
import { sendError } from "./project-scope.js";

const adminOnly = { preHandler: requireRole("administrator") };
const UuidParam = z.object({ id: z.string().uuid() });
const Rows = z.array(InstanceProcess);

/** What the student is told; it names no process (docs/EPIC-21.md ruling 14). */
export const ADMIN_STOP_NOTIFICATION_TITLE =
	"An administrator stopped a process in your workspace";

/**
 * The administrator's process list and stop (ADR 0037; SPEC.md §20.1, §24.11).
 * The list is read from Incus by the worker, never from the agent, and the API
 * never calls the controller: Refresh writes a request row and the browser
 * polls. The stop goes through the agent's checked route, as the student's does.
 */
export function registerAdminProcessRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;
	const stopping = new Set<string>();

	async function loadWorkspace(id: string) {
		return db
			.selectFrom("workspaces")
			.select(["id", "owner_user_id", "state", "agent_address", "agent_token"])
			.where("id", "=", id)
			.executeTakeFirst();
	}

	app.post(
		"/admin/workspaces/:id/processes/refresh",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = UuidParam.safeParse(request.params);
			if (!params.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid workspace id");
			}
			const row = await loadWorkspace(params.data.id);
			if (!row)
				return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
			if (row.state !== "running") {
				return sendError(
					reply,
					409,
					"WORKSPACE_NOT_RUNNING",
					"The workspace is not running",
				);
			}
			// Millisecond precision, so the worker can match the request it served.
			const requestedAt = new Date().toISOString();
			await db
				.insertInto("workspace_process_snapshots")
				.values({
					workspace_id: row.id,
					requested_at: requestedAt,
					requested_by: admin.id,
				})
				.onConflict((oc) =>
					oc
						.column("workspace_id")
						.doUpdateSet({ requested_at: requestedAt, requested_by: admin.id }),
				)
				.execute();
			return reply.status(202).send({ requestedAt });
		},
	);

	app.get("/admin/workspaces/:id/processes", adminOnly, async (request, reply) => {
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid workspace id");
		}
		const row = await loadWorkspace(params.data.id);
		if (!row)
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		const snap = await db
			.selectFrom("workspace_process_snapshots")
			.selectAll()
			.where("workspace_id", "=", row.id)
			.executeTakeFirst();
		const rows = Rows.safeParse(snap?.processes ?? []);
		const out: AdminProcessSnapshot = {
			requestedAt: snap ? snap.requested_at.toISOString() : null,
			takenAt: snap?.taken_at ? snap.taken_at.toISOString() : null,
			processes: rows.success ? rows.data : [],
			error: snap?.error ?? (rows.success ? null : "BAD_SNAPSHOT"),
		};
		return out;
	});

	app.post(
		"/admin/workspaces/:id/processes/:pid/stop",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = UuidParam.safeParse({ id: (request.params as { id: string }).id });
			const { pid: rawPid } = request.params as { pid: string };
			const pid = /^[1-9]\d{0,9}$/.test(rawPid) ? Number(rawPid) : Number.NaN;
			const body = ProcessStopRequest.safeParse(request.body ?? {});
			if (
				!params.success ||
				!Number.isSafeInteger(pid) ||
				pid > 2 ** 31 - 1 ||
				!body.success
			) {
				return sendError(reply, 400, "VALIDATION_FAILED", "invalid process id or body");
			}
			const row = await loadWorkspace(params.data.id);
			if (!row)
				return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
			if (row.state !== "running") {
				return sendError(
					reply,
					409,
					"WORKSPACE_NOT_RUNNING",
					"The workspace is not running",
				);
			}
			const agent = agentClientFor(row, config.AGENT_PORT);
			if (!agent) {
				return sendError(
					reply,
					503,
					"AGENT_UNAVAILABLE",
					"The workspace agent is not reachable.",
				);
			}
			if (stopping.has(row.id)) {
				return sendError(
					reply,
					409,
					"STOP_IN_PROGRESS",
					"A process in this workspace is already being stopped",
				);
			}
			stopping.add(row.id);
			let exited: boolean;
			try {
				({ exited } = await agent.stopProcess(pid, body.data));
			} catch (error) {
				const refusal =
					error instanceof AgentCallError
						? ProcessStopErrorCode.safeParse(error.code)
						: null;
				if (refusal?.success) {
					return sendError(
						reply,
						REFUSAL_STATUS[refusal.data],
						refusal.data,
						refusalMessage(refusal.data),
					);
				}
				if (!(error instanceof AgentCallError)) {
					request.log.error({ err: error }, "admin process stop failed");
				}
				return sendError(
					reply,
					502,
					"AGENT_UNAVAILABLE",
					"The workspace did not answer",
				);
			} finally {
				stopping.delete(row.id);
			}
			const signal = body.data.force ? "SIGKILL" : "SIGTERM";
			await db.transaction().execute(async (trx) => {
				await trx
					.insertInto("audit_events")
					.values({
						actor: `user:${admin.id}`,
						target: row.id,
						action: "workspace.process_stopped",
						result: "ok",
						metadata: JSON.stringify({ pid, signal, exited }),
					})
					.execute();
				await recordNotification(trx, row.owner_user_id, {
					tone: "neutral",
					title: ADMIN_STOP_NOTIFICATION_TITLE,
					body: "",
				});
			});
			return { pid, exited };
		},
	);
}
