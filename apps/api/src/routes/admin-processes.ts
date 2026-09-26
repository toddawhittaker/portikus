import { requireRole, requireUser } from "@portikus/auth";
import { type AdminProcessSnapshot, InstanceProcess } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { recordNotification } from "./notifications.js";
import { parseStop, stopThroughAgent } from "./processes.js";
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
			await db.transaction().execute(async (trx) => {
				await trx
					.insertInto("workspace_process_snapshots")
					.values({ workspace_id: row.id, requested_at: requestedAt })
					.onConflict((oc) =>
						oc.column("workspace_id").doUpdateSet({ requested_at: requestedAt }),
					)
					.execute();
				// Reading what a student runs is audited (SPEC.md §24.11).
				await trx
					.insertInto("audit_events")
					.values({
						actor: `user:${admin.id}`,
						target: row.id,
						action: "workspace.processes_read",
						result: "ok",
					})
					.execute();
			});
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
			const parsed = parseStop((request.params as { pid: string }).pid, request.body);
			if (!params.success || !parsed) {
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
			// The student hears only of a stop that happened (docs/EPIC-21.md ruling 14).
			return stopThroughAgent({
				db,
				agent,
				workspaceId: row.id,
				actorId: admin.id,
				pid: parsed.pid,
				body: parsed.body,
				reply,
				log: request.log,
				onExited: (trx) =>
					recordNotification(trx, row.owner_user_id, {
						tone: "neutral",
						title: ADMIN_STOP_NOTIFICATION_TITLE,
						body: "",
					}),
			});
		},
	);
}
