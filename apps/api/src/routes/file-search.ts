import {
	FileNameSearchRequest,
	FileNameSearchResponse,
	MAX_FILE_NAME_MATCHES,
	ProjectPath,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_TIMEOUT_MS } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { relayJson } from "../workspaces/agent-relay.js";
import { agentUrl, scopedProject } from "../workspaces/project-scope.js";

/**
 * The agent is untrusted (SPEC.md §24.1), so every path it names must be one
 * the file routes would accept, and the list is no longer than the contract
 * allows.
 */
const RelayedFileNames = FileNameSearchResponse.extend({
	paths: z.array(ProjectPath).max(MAX_FILE_NAME_MATCHES),
});

/**
 * File-name search for the composer's `@` menu (SPEC.md §11.1). Brokered like
 * every file route: only the workspace's owner reaches the agent, and the
 * agent is called only after the project is shown to be theirs
 * (SPEC.md §5.2, §24.6). The typed text travels in a POST body, never in a URL.
 */
export function registerFileSearchRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.post("/workspaces/:id/projects/:pid/file-search", async (request, reply) => {
		// A browser that stops waiting for a superseded search kills the
		// ripgrep behind it, so the hang-up is carried to the agent. The
		// response's close is the signal: the request's own 'close' fires as
		// soon as a POST body is read, before the search has run. It is
		// attached before any await so no hang-up is missed.
		const controller = new AbortController();
		reply.raw.once("close", () => {
			if (!reply.raw.writableFinished) controller.abort();
		});
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const body = FileNameSearchRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that file search is not valid",
			);
		}

		const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
		try {
			return await relayJson(
				reply,
				request.log,
				scope.agent,
				agentUrl(scope.slug, "file-search"),
				RelayedFileNames,
				controller.signal,
				body.data,
			);
		} finally {
			clearTimeout(timer);
		}
	});
}
