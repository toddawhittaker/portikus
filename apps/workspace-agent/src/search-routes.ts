import { SearchQuery } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { abortOnDisconnect, sendError } from "./errors.js";
import { searchProject } from "./search.js";

/** `GET /projects/:slug/search` (SPEC.md §11.5). */
export async function searchRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
): Promise<void> {
	instance.get("/projects/:slug/search", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const parsed = SearchQuery.safeParse(request.query ?? {});
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid search query" } });
		}
		// A browser that cancels a superseded search kills ripgrep with it
		// (SPEC.md §11.5).
		const signal = abortOnDisconnect(reply);
		try {
			return await searchProject(options.homeDir, slug, parsed.data.q, {
				hidden: parsed.data.hidden,
				signal,
			});
		} catch (error) {
			// The query and the matches never reach the log (STACK.md §15).
			return sendError(request, reply, error);
		}
	});
}
