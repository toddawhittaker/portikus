import { ReinstallNote } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AGENT_TIMEOUT_MS, readAgentError, readJson } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	ownedScope,
	requireAgent,
	sendAgentError,
} from "../workspaces/project-scope.js";

/**
 * The packages a rebuild removed, for the student who had installed them
 * (SPEC.md §22.3, ADR 0042). Owner-only: the list is the student's own and
 * an administrator gets the same 404 as anyone else (SPEC.md §20.1). The
 * package names are not logged.
 */
export function registerReinstallNoteRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;

	app.get("/workspaces/:id/reinstall-note", async (request, reply) => {
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const agent = requireAgent(scope, reply);
		if (!agent) return;
		let response: Response;
		try {
			response = await agent.fetchRaw("GET", "/packages/reinstall-note", {
				signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) return sendAgentError(reply, await readAgentError(response));
		const parsed = ReinstallNote.safeParse(await readJson(response));
		if (!parsed.success) {
			request.log.error(
				{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
				"the workspace agent sent a reinstall note the contract rejected",
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

	app.post("/workspaces/:id/reinstall-note/dismiss", async (request, reply) => {
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const agent = requireAgent(scope, reply);
		if (!agent) return;
		let response: Response;
		try {
			response = await agent.fetchRaw("POST", "/packages/reinstall-note/dismiss", {
				signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) return sendAgentError(reply, await readAgentError(response));
		return reply.code(204).send();
	});
}
