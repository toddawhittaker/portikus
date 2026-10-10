import {
	GitRef,
	GitStatusQuery,
	NO_LINKS_QUERY,
	ProjectPath,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentFailure, sendError } from "./errors.js";
import { baselineDiff, baselineStatus, gitDiff, gitStatus, OBJECT_ID } from "./git.js";
import { refDiff } from "./git-compare.js";

const DiffQuery = z.object({ path: ProjectPath, ref: GitRef.optional() });

/** Whether a shared read asked for symlinks to be refused (SPEC.md §5.2). */
function noLinks(query: unknown): boolean {
	return (query as Record<string, unknown> | undefined)?.[NO_LINKS_QUERY] === "1";
}

/** A full object id, SHA-1 or SHA-256. Anything else is refused. */
const ObjectQuery = z.object({
	object: z.string().regex(OBJECT_ID),
});

const BaselineDiffQuery = ObjectQuery.extend({ path: ProjectPath });

/**
 * The read-only Git routes (SPEC.md §12.1, §12.6, §12.8). Paths are logged at
 * debug only and file contents never (STACK.md §15).
 */
export async function gitRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
): Promise<void> {
	instance.get("/projects/:slug/git/status", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const query = GitStatusQuery.safeParse(request.query ?? {});
			if (!query.success) {
				throw new AgentFailure("BAD_REQUEST", "invalid hidden flag");
			}
			return await gitStatus(options.homeDir, slug, {
				hidden: query.data.hidden,
				noLinks: noLinks(request.query),
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
				if (query.error.issues.some((issue) => issue.path[0] === "ref")) {
					throw new AgentFailure("BAD_REQUEST", "invalid ref");
				}
				throw new AgentFailure("PATH_INVALID", "invalid path");
			}
			const { path, ref } = query.data;
			if (ref === undefined) {
				return await gitDiff(options.homeDir, slug, path, {
					noLinks: noLinks(request.query),
					log: request.log,
				});
			}
			// Compare with a ref the student typed (SPEC.md §12.6).
			return await refDiff(options.homeDir, slug, path, ref, { log: request.log });
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
