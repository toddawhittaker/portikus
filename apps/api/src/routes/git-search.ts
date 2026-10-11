import {
	GitDiff,
	GitRef,
	GitStatus,
	GitStatusQuery,
	MAX_SEARCH_MATCHES,
	ProjectPath,
	SEARCH_TIMEOUT_MS,
	SearchQuery,
	SearchResponse,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_TIMEOUT_MS } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	GIT_DIFF_BUDGET_MS,
	GIT_STATUS_BUDGET_MS,
	relayJson,
} from "../workspaces/agent-relay.js";
import { agentUrl, scopedProject } from "../workspaces/project-scope.js";

/** The agent's search budget plus the time a healthy agent needs to answer (SPEC.md §11.5). */
const SEARCH_BUDGET_MS = SEARCH_TIMEOUT_MS + AGENT_TIMEOUT_MS;

/**
 * The agent is untrusted (SPEC.md §24.1), so its matches are cut to the
 * contract limit here too, and marked truncated the way the agent marks its
 * own cut.
 */
const RelayedSearchResponse = SearchResponse.transform((answer) =>
	answer.matches.length > MAX_SEARCH_MATCHES
		? { matches: answer.matches.slice(0, MAX_SEARCH_MATCHES), truncated: true }
		: answer,
);

/**
 * Read-only Git and search routes (SPEC.md §11.5, §12.1, §12.6). The control
 * plane brokers every one: the browser never reaches the workspace agent, and
 * the agent is only called after the caller has been shown to own the
 * workspace and the project (SPEC.md §5.2, §24.6).
 */
export function registerGitSearchRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	// SPEC.md §12.1.
	app.get("/workspaces/:id/projects/:pid/git/status", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const query = GitStatusQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "hidden must be true or false");
		}
		return relayJson(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "git/status", { hidden: String(query.data.hidden) }),
			GitStatus,
			AbortSignal.timeout(GIT_STATUS_BUDGET_MS),
		);
	});

	// HEAD against the working tree for one file
	// (SPEC.md §12.6), or a ref against the working tree. The path is checked here as well as in the agent, so
	// a traversal attempt never leaves the control plane (SPEC.md §24.6).
	app.get("/workspaces/:id/projects/:pid/git/diff", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const query = (request.query ?? {}) as { path?: unknown; ref?: unknown };
		const path = ProjectPath.safeParse(query.path);
		if (!path.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that path is not inside the project",
			);
		}
		// An optional ref compares with that commit instead of HEAD.
		const params: Record<string, string> = { path: path.data };
		if (query.ref !== undefined) {
			const ref = GitRef.safeParse(query.ref);
			if (!ref.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "That Git ref is not valid.");
			}
			params.ref = ref.data;
		}
		return relayJson(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "git/diff", params),
			GitDiff,
			AbortSignal.timeout(GIT_DIFF_BUDGET_MS),
		);
	});

	// Baseline status and diff: the same Git shapes, compared
	// with the object recorded when a launcher started (SPEC.md §10.9, §12.7).
	// The agent paths are /projects/:slug/baseline-status and baseline-diff.
	const BaselineObject = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

	app.get("/workspaces/:id/projects/:pid/baseline-status", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const object = BaselineObject.safeParse(
			(request.query as { object?: unknown })?.object,
		);
		if (!object.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"object must be a Git object id",
			);
		}
		return relayJson(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "baseline-status", { object: object.data }),
			GitStatus,
			AbortSignal.timeout(GIT_STATUS_BUDGET_MS),
		);
	});

	app.get("/workspaces/:id/projects/:pid/baseline-diff", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		const query = request.query as { object?: unknown; path?: unknown };
		const object = BaselineObject.safeParse(query.object);
		if (!object.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"object must be a Git object id",
			);
		}
		const path = ProjectPath.safeParse(query.path);
		if (!path.success) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"that path is not inside the project",
			);
		}
		return relayJson(
			reply,
			request.log,
			scope.agent,
			agentUrl(scope.slug, "baseline-diff", { object: object.data, path: path.data }),
			GitDiff,
			AbortSignal.timeout(GIT_DIFF_BUDGET_MS),
		);
	});

	// SPEC.md §11.5.
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
			return await relayJson(
				reply,
				request.log,
				scope.agent,
				agentUrl(scope.slug, "search", {
					q: query.data.q,
					hidden: String(query.data.hidden),
					regex: String(query.data.regex),
					caseSensitive: String(query.data.caseSensitive),
					wholeWord: String(query.data.wholeWord),
				}),
				RelayedSearchResponse,
				controller.signal,
			);
		} finally {
			clearTimeout(timer);
			request.raw.off("close", onClose);
		}
	});
}
