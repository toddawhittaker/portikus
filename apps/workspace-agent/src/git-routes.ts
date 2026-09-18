import { GitStatusQuery } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { gitDiff, gitStatus } from "./git.js";
import { AgentFailure } from "./tmux.js";

const DiffQuery = z.object({ path: z.string().min(1).max(1024) });

type SendError = (
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
) => unknown;

/**
 * The read-only Git routes (SPEC.md §12.1, §12.6, §12.8). Paths are logged at
 * debug only and file contents never (STACK.md §15).
 */
export function registerGitRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
	sendError: SendError,
): void {
	instance.get("/projects/:slug/git/status", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const query = GitStatusQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid hidden flag" } });
		}
		try {
			return await gitStatus(options.homeDir, slug, { hidden: query.data.hidden });
		} catch (error) {
			return sendError(request, reply, error);
		}
	});

	instance.get("/projects/:slug/git/diff", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const query = DiffQuery.safeParse(request.query ?? {});
		try {
			if (!query.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			return await gitDiff(options.homeDir, slug, query.data.path);
		} catch (error) {
			return sendError(request, reply, error);
		}
	});
}
