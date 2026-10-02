import type { WebSocket } from "@fastify/websocket";
import { CheckId, CheckRun, ChecksResponse } from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AGENT_TIMEOUT_MS, readAgentError, readJson } from "../agent-client.js";
import { sendError } from "../http.js";
import type { ServerDeps } from "../server.js";
import { createPendingWork, workspaceUpgradeGuard } from "./presence.js";
import {
	agentUrl,
	type ProjectScope,
	scopedProject,
	sendAgentError,
} from "./project-scope.js";
import { pipeOneWay } from "./terminal-pipe.js";

/** A run may take a while to start, but starting it is not itself slow. */
const CHECK_BUDGET_MS = AGENT_TIMEOUT_MS;

declare module "fastify" {
	interface FastifyRequest {
		/** The project the check output guard already loaded and authorized. */
		checkScope?: ProjectScope;
	}
}

/** The check id from the route, or null after answering 400. */
function checkIdOf(request: FastifyRequest): string | null {
	const raw = (request.params as { checkId?: unknown }).checkId;
	const parsed = CheckId.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Project checks, brokered for the browser (SPEC.md §18.1). Every route goes
 * through the same ownership gate as the other project routes: the browser
 * never reaches the workspace agent, and the agent is only called once the
 * caller has been shown to own the workspace and the project
 * (SPEC.md §5.2, §24.6).
 */
export function registerCheckRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const { track, drain } = createPendingWork();

	// The configured checks of one project, plus what each last did.
	app.get("/workspaces/:id/projects/:pid/checks", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		let response: Response;
		try {
			response = await scope.agent.fetchRaw("GET", agentUrl(scope.slug, "checks"), {
				signal: AbortSignal.timeout(CHECK_BUDGET_MS),
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) return sendAgentError(reply, await readAgentError(response));
		const parsed = ChecksResponse.safeParse(await readJson(response));
		if (!parsed.success) {
			// The definitions are student content and never reach a log.
			request.log.error(
				{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
				"the workspace agent sent checks the contract rejected",
			);
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent sent an answer we could not read.",
			);
		}
		return parsed.data;
	});

	// Start one check.
	app.post(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs",
		async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const checkId = checkIdOf(request);
			if (!checkId) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that is not a check id");
			}
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"POST",
					agentUrl(scope.slug, `checks/${checkId}/runs`),
					{ signal: AbortSignal.timeout(CHECK_BUDGET_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return sendAgentError(reply, await readAgentError(response));
			const parsed = CheckRun.safeParse(await readJson(response));
			if (!parsed.success) {
				return sendError(
					reply,
					503,
					"AGENT_UNAVAILABLE",
					"The workspace agent sent an answer we could not read.",
				);
			}
			return reply.code(201).send(parsed.data);
		},
	);

	// Stop the run that is going now.
	// jscpd:ignore-start -- each route spells out its own checks, in order.
	app.delete(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs/current",
		async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const checkId = checkIdOf(request);
			if (!checkId) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that is not a check id");
			}
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"DELETE",
					agentUrl(scope.slug, `checks/${checkId}/runs/current`),
					{ signal: AbortSignal.timeout(CHECK_BUDGET_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return sendAgentError(reply, await readAgentError(response));
			return reply.code(204).send();
		},
	);
	// jscpd:ignore-end

	// The output of the current run, replayed then streamed. Nothing travels
	// the other way: a check panel is read-only (SPEC.md §18.1).
	app.get(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs/current",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				async (request, reply) => {
					const scope = await scopedProject(db, config, request, reply);
					if (!scope) return reply;
					request.checkScope = scope;
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			socket.pause();
			const scope = request.checkScope;
			const checkId = checkIdOf(request);
			if (!scope || !checkId) {
				socket.close(1008, "invalid check");
				socket.resume();
				return;
			}
			track(
				pipeOneWay({
					db,
					socket,
					url: scope.agent.checkOutputUrl(scope.slug, checkId),
					authHeader: scope.agent.authHeader(),
					workspaceId: scope.workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
					closeReason: () => "run finished",
					failureMessage: "check output agent socket failed",
				}),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}
