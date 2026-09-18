import {
	GitDiff,
	GitStatus,
	GitStatusQuery,
	ProjectPath,
	SEARCH_TIMEOUT_MS,
	SearchQuery,
	SearchResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { z } from "zod";
import {
	AGENT_TIMEOUT_MS,
	type AgentClient,
	readAgentError,
	readJson,
} from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { scopedProject, sendAgentError, sendError } from "./project-scope.js";

/**
 * How long the agent has to answer a search. Its own ripgrep budget is
 * SEARCH_TIMEOUT_MS, so the control plane waits a little longer than that
 * before it gives up on the agent itself.
 */
const SEARCH_BUDGET_MS = SEARCH_TIMEOUT_MS + AGENT_TIMEOUT_MS;

/** The agent path for one route of one project. */
function agentUrl(slug: string, route: string, query: Record<string, string>) {
	const search = new URLSearchParams(query).toString();
	return `/projects/${encodeURIComponent(slug)}/${route}?${search}`;
}

/**
 * Read-only Git and search routes (SPEC.md §11.5, §12.1, §12.6). The control
 * plane brokers every one: the browser never reaches the workspace agent, and
 * the agent is only called after the caller has been shown to own the
 * workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerGitSearchRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.register(async (instance) => {
		/**
		 * Call the agent and relay its JSON, checked against the contract. One
		 * shape for all three routes: anything the contract does not accept is
		 * the agent's fault, not the student's.
		 */
		async function relay<T extends z.ZodTypeAny>(
			reply: FastifyReply,
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

		// GET git/status -- the repository state of one project (SPEC.md §12.1).
		instance.get("/workspaces/:id/projects/:pid/git/status", async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const query = GitStatusQuery.safeParse(request.query ?? {});
			if (!query.success) {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"hidden must be true or false",
				);
			}
			return relay(
				reply,
				scope.agent,
				agentUrl(scope.slug, "git/status", {
					hidden: String(query.data.hidden),
				}),
				GitStatus,
				AbortSignal.timeout(AGENT_TIMEOUT_MS),
			);
		});

		// GET git/diff -- HEAD against the working tree for one file
		// (SPEC.md §12.6). The path is checked here as well as in the agent, so
		// a traversal attempt never leaves the control plane (SPEC.md §24.6).
		instance.get("/workspaces/:id/projects/:pid/git/diff", async (request, reply) => {
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
				scope.agent,
				agentUrl(scope.slug, "git/diff", { path: path.data }),
				GitDiff,
				AbortSignal.timeout(AGENT_TIMEOUT_MS),
			);
		});

		// GET search -- project-wide text search (SPEC.md §11.5).
		instance.get("/workspaces/:id/projects/:pid/search", async (request, reply) => {
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
	});
}
