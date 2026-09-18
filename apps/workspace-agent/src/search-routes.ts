import { type AgentErrorCode, SearchQuery } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { searchProject } from "./search.js";
import { AgentFailure } from "./tmux.js";

/** The only failures a search can produce (SPEC.md §27). */
const SEARCH_ERROR_STATUS: Partial<Record<AgentErrorCode, number>> = {
	INVALID_SLUG: 400,
	PROJECT_NOT_FOUND: 404,
	SEARCH_FAILED: 500,
};

export interface SearchRouteOptions {
	homeDir: string;
}

/** `GET /projects/:slug/search` (SPEC.md §11.5). */
export function registerSearchRoutes(
	app: FastifyInstance,
	options: SearchRouteOptions,
): void {
	app.get("/projects/:slug/search", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const parsed = SearchQuery.safeParse(request.query ?? {});
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid search query" } });
		}
		// A browser that cancels a superseded search kills ripgrep with it
		// (SPEC.md §11.5).
		const controller = new AbortController();
		request.raw.on("close", () => controller.abort());
		try {
			return await searchProject(options.homeDir, slug, parsed.data.q, {
				hidden: parsed.data.hidden,
				signal: controller.signal,
			});
		} catch (error) {
			if (error instanceof AgentFailure) {
				return reply
					.code(SEARCH_ERROR_STATUS[error.code] ?? 500)
					.send({ error: { code: error.code, message: error.message } });
			}
			// The query and the matches never reach the log (STACK.md §15).
			request.log.error(
				{ slug, error: error instanceof Error ? error.message : String(error) },
				"search failed",
			);
			return reply
				.code(500)
				.send({ error: { code: "SEARCH_FAILED", message: "internal error" } });
		}
	});
}
