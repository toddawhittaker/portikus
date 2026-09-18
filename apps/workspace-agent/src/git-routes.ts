import { GitStatusQuery, ProjectPath } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "./errors.js";
import { gitDiff, gitStatus } from "./git.js";
import { AgentFailure } from "./tmux.js";

const DiffQuery = z.object({ path: ProjectPath });

/**
 * The read-only Git routes (SPEC.md §12.1, §12.6, §12.8). Paths are logged at
 * debug only and file contents never (STACK.md §15).
 */
export function registerGitRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
): void {
	instance.get("/projects/:slug/git/status", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const query = GitStatusQuery.safeParse(request.query ?? {});
			if (!query.success) {
				throw new AgentFailure("BAD_REQUEST", "invalid hidden flag");
			}
			return await gitStatus(options.homeDir, slug, {
				hidden: query.data.hidden,
				log: request.log,
			});
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get("/projects/:slug/git/diff", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const query = DiffQuery.safeParse(request.query ?? {});
			if (!query.success) {
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			return await gitDiff(options.homeDir, slug, query.data.path, {
				log: request.log,
			});
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});
}
