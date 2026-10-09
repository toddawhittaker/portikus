import type { GitDiff, GitStatus } from "@portikus/contracts";
import { GitStatusQuery, ProjectPath } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { FakeFileError } from "./fs-model.js";
import { emptyStatus, type FakeAgentState } from "./state.js";

/** The read-only Git routes, like the agent's git-routes.ts (SPEC.md §12.1, §12.6, §12.7). */
export function registerGitRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { gitAnswers, projectNotFound, answerKey, keyOf, dirs, fileError } = s;
	/**
	 * A slug the test marks as slow stands in for a git command that takes
	 * most of the agent's own per-command budget, so the control plane's wait
	 * can be observed.
	 */
	const SLOW_GIT_MS = 6000;
	async function slowIfMarked(slug: string): Promise<void> {
		if (!slug.includes("slow")) return;
		await new Promise((resolve) => setTimeout(resolve, SLOW_GIT_MS));
	}

	app.get("/projects/:slug/git/status", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		await slowIfMarked(slug);
		const query = GitStatusQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid hidden flag"));
		}
		const status = gitAnswers.get(answerKey(keyOf(request), slug))?.status;
		if (!status) return emptyStatus();
		// Ignored paths are only sent when hidden files are shown.
		return query.data.hidden ? status : { ...status, ignored: [] };
	});

	app.get("/projects/:slug/git/diff", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		await slowIfMarked(slug);
		const path = (request.query as { path?: string }).path ?? "";
		if (!ProjectPath.safeParse(path).success) {
			return fileError(reply, new FakeFileError("PATH_INVALID", "invalid path"));
		}
		const diffs = gitAnswers.get(answerKey(keyOf(request), slug))?.diffs;
		const ref = (request.query as { ref?: string }).ref;
		if (ref !== undefined) {
			// A comparison with a ref is seeded as `ref:path`; any other ref
			// names no commit, as the real agent answers (SPEC.md §12.6).
			const atRef = diffs?.[`${ref}:${path}`];
			if (!atRef) {
				return fileError(
					reply,
					new FakeFileError("BAD_REQUEST", "That Git ref does not name a commit."),
				);
			}
			return atRef;
		}
		const diff = diffs?.[path];
		// Like the real agent, a path on neither side is an empty addition,
		// not a 404: the older side may still have had it (SPEC.md §12.6).
		return (
			diff ?? { status: "A", before: null, after: null, binary: false, tooLarge: false }
		);
	});

	// Session review uses the same seeded Git answers (SPEC.md §12.7).
	app.get("/projects/:slug/baseline-status", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const object = (request.query as { object?: string }).object ?? "";
		if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(object)) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid object"));
		}
		const status = gitAnswers.get(answerKey(keyOf(request), slug))?.status;
		return status ?? emptyStatus();
	});

	app.get("/projects/:slug/baseline-diff", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const query = request.query as { object?: string; path?: string };
		if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(query.object ?? "")) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid object"));
		}
		const path = query.path ?? "";
		if (!ProjectPath.safeParse(path).success) {
			return fileError(reply, new FakeFileError("PATH_INVALID", "invalid path"));
		}
		const diff = gitAnswers.get(answerKey(keyOf(request), slug))?.diffs?.[path];
		if (!diff) {
			return fileError(reply, new FakeFileError("FILE_NOT_FOUND", "no such file"));
		}
		return diff;
	});

	// Test-only hooks for Git, search and events.
	app.post("/__test/git", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			status?: GitStatus;
			diffs?: Record<string, GitDiff>;
		};
		gitAnswers.set(answerKey(body.key ?? "", body.slug), {
			status: body.status,
			diffs: body.diffs,
		});
		return reply.status(204).send();
	});
}
