import { requireUser } from "@portikus/auth";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { parseStop, stopThroughAgent } from "../workspaces/process-stop.js";
import { ownedScope } from "../workspaces/project-scope.js";

/**
 * The student stops one of their own processes (SPEC.md §18.3). Owner-only; the
 * agent checks the PID, its start ticks
 * and the protected list.
 */
export function registerProcessRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.post("/workspaces/:id/processes/:pid/stop", async (request, reply) => {
		const user = requireUser(request);
		const parsed = parseStop((request.params as { pid: string }).pid, request.body);
		if (!parsed) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid process id or body");
		}
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		if (!scope.running) {
			return sendError(
				reply,
				409,
				"WORKSPACE_NOT_RUNNING",
				"The workspace is not running",
			);
		}
		if (!scope.agent) {
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent is not reachable.",
			);
		}
		return stopThroughAgent({
			db,
			agent: scope.agent,
			workspaceId: scope.workspaceId,
			actorId: user.id,
			pid: parsed.pid,
			body: parsed.body,
			reply,
			log: request.log,
		});
	});
}
