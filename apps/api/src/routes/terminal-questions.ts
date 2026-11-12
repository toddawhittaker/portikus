import { requireUser } from "@portikus/auth";
import { TerminalQuestionAnswer } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { parseFieldsOr400, parseOr400, sendError } from "../http.js";
import { sendAgentError } from "../workspaces/project-scope.js";
import { findWorkspaceOwnedBy } from "../workspaces/workspace-view.js";

const TerminalParam = z.object({ id: z.string().uuid(), tid: z.string().uuid() });

/**
 * The student's answer to the question their terminal's Claude Code is
 * waiting on (SPEC.md 10.8). Owner only: an administrator, an instructor, a
 * share viewer and a live-help helper get the same 404 as for any other
 * workspace route (SPEC.md 24.1). Only an open terminal tab takes one; a chat
 * has its own relay. The body goes to the agent unread beyond its shape. It
 * is never logged or stored, and no audit row is written (STACK.md 15).
 */
export function registerTerminalQuestionRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	app.post("/workspaces/:id/terminals/:tid/question", async (request, reply) => {
		const user = requireUser(request);
		const params = parseOr400(TerminalParam, request.params, reply);
		if (!params) return;
		const body = parseFieldsOr400(TerminalQuestionAnswer, request.body, reply);
		if (!body) return;

		const workspace = await findWorkspaceOwnedBy(db, params.id, user.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}
		const terminal = await db
			.selectFrom("terminals")
			.select("kind")
			.where("id", "=", params.tid)
			.where("workspace_id", "=", params.id)
			.where("ended_at", "is", null)
			.executeTakeFirst();
		if (terminal?.kind !== "terminal") {
			return sendError(reply, 404, "TERMINAL_NOT_FOUND", "Terminal not found");
		}
		const agent =
			workspace.state === "running"
				? agentClientFor(workspace, config.AGENT_PORT)
				: null;
		if (!agent) {
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent is not reachable.",
			);
		}

		try {
			if (!(await agent.answerTerminalQuestion(params.tid, body))) {
				return sendError(
					reply,
					409,
					"BUSY",
					"That question was answered in the terminal or timed out.",
				);
			}
		} catch (error) {
			return sendAgentError(reply, error);
		}
		return reply.status(204).send();
	});
}
