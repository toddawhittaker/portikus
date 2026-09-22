import { GitStatusQuery, ProjectPath } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "./errors.js";
import { baselineDiff, baselineStatus, gitDiff, gitStatus } from "./git.js";
import { AgentFailure } from "./tmux.js";

const DiffQuery = z.object({ path: ProjectPath });

/** A full object id from `git stash create`. Anything else is refused. */
const ObjectQuery = z.object({
	object: z.string().regex(/^[0-9a-f]{40}$/),
});

const BaselineDiffQuery = ObjectQuery.extend({ path: ProjectPath });

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

	// Session review against the dangling baseline object (SPEC.md §12.7).
	// These do not move refs. The API task relays the same paths.
	instance.get("/projects/:slug/baseline-status", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const query = ObjectQuery.safeParse(request.query ?? {});
			if (!query.success) {
				throw new AgentFailure("BAD_REQUEST", "invalid object");
			}
			return await baselineStatus(options.homeDir, slug, query.data.object, {
				log: request.log,
			});
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get("/projects/:slug/baseline-diff", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const query = BaselineDiffQuery.safeParse(request.query ?? {});
			if (!query.success) {
				throw new AgentFailure("BAD_REQUEST", "invalid object or path");
			}
			return await baselineDiff(
				options.homeDir,
				slug,
				query.data.object,
				query.data.path,
				{ log: request.log },
			);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});
}
