import { requireUser } from "@portikus/auth";
import { ProcessPriorityRequest, ProcessTreeStopRequest } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import type { AgentClient } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	actThroughAgent,
	parseProcessTarget,
	parseStop,
	stopThroughAgent,
} from "../workspaces/process-stop.js";
import { ownedScope } from "../workspaces/project-scope.js";

/**
 * The student stops one of their own processes, stops it with its children,
 * or lowers its priority (SPEC.md §18.3). Owner-only; the agent checks every
 * PID, its start ticks and the protected list.
 */
export function registerProcessRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	/** The parsed target and a reachable agent, or null once an error is sent. */
	async function target<T>(
		request: FastifyRequest,
		reply: FastifyReply,
		parse: (rawPid: string, rawBody: unknown) => { pid: number; body: T } | null,
	): Promise<{ pid: number; body: T; agent: AgentClient; workspaceId: string } | null> {
		const parsed = parse((request.params as { pid: string }).pid, request.body);
		if (!parsed) {
			sendError(reply, 400, "VALIDATION_FAILED", "invalid process id or body");
			return null;
		}
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return null;
		if (!scope.running) {
			sendError(reply, 409, "WORKSPACE_NOT_RUNNING", "The workspace is not running");
			return null;
		}
		if (!scope.agent) {
			sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent is not reachable.",
			);
			return null;
		}
		return { ...parsed, agent: scope.agent, workspaceId: scope.workspaceId };
	}

	function parseWith<T>(schema: ZodType<T>) {
		return (rawPid: string, rawBody: unknown) =>
			parseProcessTarget(rawPid, rawBody, schema);
	}

	app.post("/workspaces/:id/processes/:pid/stop", async (request, reply) => {
		const user = requireUser(request);
		const found = await target(request, reply, parseStop);
		if (!found) return reply;
		return stopThroughAgent({
			db,
			agent: found.agent,
			workspaceId: found.workspaceId,
			actorId: user.id,
			pid: found.pid,
			body: found.body,
			reply,
			log: request.log,
		});
	});

	app.post("/workspaces/:id/processes/:pid/stop-tree", async (request, reply) => {
		const user = requireUser(request);
		const found = await target(request, reply, parseWith(ProcessTreeStopRequest));
		if (!found) return reply;
		const { agent, pid, body } = found;
		const signal = body.force ? "SIGKILL" : "SIGTERM";
		return actThroughAgent({
			db,
			workspaceId: found.workspaceId,
			actorId: user.id,
			reply,
			log: request.log,
			call: () => agent.stopProcessTree(pid, body),
			audit: ({ exited, signalled }) => ({
				action: "workspace.process_stopped",
				// A Force stop names its PIDs; record how many, never which (SPEC.md §24).
				metadata: {
					pid,
					signal,
					exited,
					tree: true,
					signalled,
					...(body.remaining ? { named: body.remaining.length } : {}),
				},
			}),
		});
	});

	app.post("/workspaces/:id/processes/:pid/lower-priority", async (request, reply) => {
		const user = requireUser(request);
		const found = await target(request, reply, parseWith(ProcessPriorityRequest));
		if (!found) return reply;
		const { agent, pid, body } = found;
		return actThroughAgent({
			db,
			workspaceId: found.workspaceId,
			actorId: user.id,
			reply,
			log: request.log,
			call: () => agent.lowerProcessPriority(pid, body),
			audit: ({ lowered }) => ({
				action: "workspace.process_priority_lowered",
				metadata: { pid, lowered },
			}),
		});
	});
}
