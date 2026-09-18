import {
	GIT_TIMEOUT_MS,
	GitDiff,
	GitStatus,
	GitStatusQuery,
	ProjectPath,
	SEARCH_TIMEOUT_MS,
	SearchQuery,
	SearchResponse,
} from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { z } from "zod";
import {
	AGENT_TIMEOUT_MS,
	type AgentClient,
	readAgentError,
	readJson,
} from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { agentUrl, scopedProject, sendAgentError, sendError } from "./project-scope.js";

/**
 * How long the agent has to answer, route by route. Each budget is the
 * agent's own work budget plus the time a healthy agent needs to hand the
 * answer back, so the control plane never gives up on a command the agent is
 * still allowed to be running (SPEC.md §11.5, §12.1, §12.6).
 */
const SEARCH_BUDGET_MS = SEARCH_TIMEOUT_MS + AGENT_TIMEOUT_MS;
const STATUS_BUDGET_MS = GIT_TIMEOUT_MS + AGENT_TIMEOUT_MS;
/** A diff runs two git commands, one for each side. */
const DIFF_BUDGET_MS = GIT_TIMEOUT_MS * 2 + AGENT_TIMEOUT_MS;

/**
 * Call the agent and relay its JSON, checked against the contract. One shape
 * for all three routes: anything the contract does not accept is the agent's
 * fault, not the student's.
 */
async function relay<T extends z.ZodTypeAny>(
	reply: FastifyReply,
	log: FastifyBaseLogger,
	agent: AgentClient,
	path: string,
	schema: T,
	signal: AbortSignal,
): Promise<z.infer<T> | undefined> {
	let response: Response;
	try {
		response = await agent.fetchRaw("GET", path, { signal });
	} catch (error) {
		sendAgentError(reply, error);
		return undefined;
	}
	if (!response.ok) {
		sendAgentError(reply, await readAgentError(response));
		return undefined;
	}
	const parsed = schema.safeParse(await readJson(response));
	if (!parsed.success) {
		// Only where the answer went wrong is logged; the values are student
		// content and never reach a log (STACK.md §15).
		log.error(
			{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
			"the workspace agent sent an answer the contract rejected",
		);
		sendError(
			reply,
			503,
			"AGENT_UNAVAILABLE",
			"The workspace agent sent an answer we could not read.",
		);
		return undefined;
	}
	return parsed.data;
}

/**
 * Read-only Git and search routes (SPEC.md §11.5, §12.1, §12.6). The control
 * plane brokers every one: the browser never reaches the workspace agent, and
 * the agent is only called after the caller has been shown to own the
 * workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerGitSearchRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	// GET git/status -- the repository state of one project (SPEC.md §12.1).
	app.get("/workspaces/:id/projects/:pid/git/status", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const query = GitStatusQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "hidden must be true or false");
		}
		return relay(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "git/status", { hidden: String(query.data.hidden) }),
			GitStatus,
			AbortSignal.timeout(STATUS_BUDGET_MS),
		);
	});

	// GET git/diff -- HEAD against the working tree for one file
	// (SPEC.md §12.6). The path is checked here as well as in the agent, so
	// a traversal attempt never leaves the control plane (SPEC.md §24.6).
	app.get("/workspaces/:id/projects/:pid/git/diff", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const path = ProjectPath.safeParse((request.query as { path?: unknown })?.path);
		if (!path.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that path is not inside the project",
			);
		}
		return relay(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "git/diff", { path: path.data }),
			GitDiff,
			AbortSignal.timeout(DIFF_BUDGET_MS),
		);
	});

	// GET search -- project-wide text search (SPEC.md §11.5).
	app.get("/workspaces/:id/projects/:pid/search", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const query = SearchQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that search query is not valid",
			);
		}

		// A browser that cancels a superseded search must kill the ripgrep
		// behind it, so the cancellation is carried to the agent
		// (SPEC.md §11.5).
		const controller = new AbortController();
		const onClose = () => controller.abort();
		request.raw.on("close", onClose);
		const timer = setTimeout(() => controller.abort(), SEARCH_BUDGET_MS);
		try {
			return await relay(
				reply,
				request.log,
				scope.agent,
				agentUrl(scope.slug, "search", {
					q: query.data.q,
					hidden: String(query.data.hidden),
				}),
				SearchResponse,
				controller.signal,
			);
		} finally {
			clearTimeout(timer);
			request.raw.off("close", onClose);
		}
	});
}
