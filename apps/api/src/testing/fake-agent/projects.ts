import { MAX_DOWNLOAD_BYTES, projectNameFromRepository } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import {
	FakeFileError,
	nextDirectoryId,
	nodeKey,
	oneFileZip,
	rekeyTree,
	removeTree,
} from "./fs-model.js";
import { emptyStatus, type FakeAgentState } from "./state.js";

/** The ~/projects routes, like the agent's projects.ts (SPEC.md §10). */
export function registerProjectRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		gitAnswers,
		projectNotFound,
		dirsForKey,
		answerKey,
		keyOf,
		dirs,
		filesForKey,
		fsOf,
		fileError,
	} = s;
	app.get("/projects", async (request) => ({
		projects: [...dirs(request)].map(([slug, value]) => ({
			directoryId: value.directoryId,
			slug,
			isGitRepo: value.isGitRepo,
		})),
	}));

	app.get("/projects/:slug", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const project = dirs(request).get(slug);
		if (!project) return projectNotFound(reply);
		return {
			slug,
			isGitRepo: project.isGitRepo,
			directoryId: project.directoryId,
		};
	});

	app.post("/projects", async (request, reply) => {
		const body = request.body as {
			slug: string;
			source: "new" | "clone" | "template";
			url?: string;
			gitInit: boolean;
		};
		const here = dirs(request);
		if (here.has(body.slug)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		// A url the test marks as diskfull stands in for a clone on a full disk.
		if (body.source !== "new" && (body.url ?? "").includes("diskfull")) {
			return reply.status(507).send({
				error: { code: "STORAGE_FULL", message: "no space left in the home folder" },
			});
		}
		// A url the test marks as failing stands in for a clone that goes wrong.
		if (body.source !== "new" && (body.url ?? "").includes("fail")) {
			return reply
				.status(400)
				.send({ error: { code: "GIT_FAILED", message: "clone failed" } });
		}
		// A url the test marks as slow stands in for a clone that takes a while.
		if ((body.url ?? "").includes("slow")) {
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const isGitRepo = body.source === "new" ? body.gitInit : true;
		here.set(body.slug, { isGitRepo, directoryId: nextDirectoryId() });
		const tree = fsOf(request);
		if (body.source === "clone") {
			// A url the test marks with "readme" clones a repository that names
			// itself in its README heading, as the real agent reads it.
			if (!(body.url ?? "").includes("readme")) {
				return reply.status(201).send({ slug: body.slug, isGitRepo });
			}
			const readme = "# The **Fixture** Repository\n\nHello.\n";
			tree.set(nodeKey(body.slug, "README.md"), {
				type: "file",
				content: Buffer.from(readme),
			});
			const suggestedName = projectNameFromRepository({ readme });
			return reply.status(201).send({ slug: body.slug, isGitRepo, suggestedName });
		}
		// A repository the fake creates starts on main, as the real one does.
		// Its files are not seeded, because tests rely on a new
		// project being empty; the agent's own tests cover those files.
		if (isGitRepo) {
			gitAnswers.set(answerKey(keyOf(request), body.slug), {
				status: { ...emptyStatus(), repo: true, branch: "main" },
			});
		}
		return reply.status(201).send({ slug: body.slug, isGitRepo });
	});

	app.delete("/projects/:slug", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).delete(slug)) return projectNotFound(reply);
		removeTree(fsOf(request), slug);
		return reply.status(204).send();
	});

	app.post("/projects/:slug/rename", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const here = dirs(request);
		const project = here.get(slug);
		if (!project) return projectNotFound(reply);
		if (here.has(to)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		here.delete(slug);
		here.set(to, project);
		rekeyTree(fsOf(request), slug, to, { copy: false });
		return reply.status(204).send();
	});

	app.post("/projects/:slug/duplicate", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const here = dirs(request);
		const project = here.get(slug);
		if (!project) return projectNotFound(reply);
		if (here.has(to)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		here.set(to, { isGitRepo: project.isGitRepo, directoryId: nextDirectoryId() });
		rekeyTree(fsOf(request), slug, to, { copy: true });
		return reply.status(201).send({ slug: to, isGitRepo: project.isGitRepo });
	});

	app.post("/projects/:slug/git-init", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const project = dirs(request).get(slug);
		if (!project) return projectNotFound(reply);
		project.isGitRepo = true;
		return reply.status(204).send();
	});

	app.get("/projects/:slug/archive", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const query = request.query as { path?: string | string[]; check?: string };
		// A repeated `path` is a selection of several files and folders.
		const paths = Array.isArray(query.path) ? query.path : [query.path ?? ""];
		const path = paths.length > 1 ? "" : (paths[0] ?? "");
		const tree = fsOf(request);
		// The same size check as the real agent, before any zipping.
		let total = 0;
		for (const selected of paths) {
			const key = nodeKey(slug, selected);
			if (selected !== "" && !tree.has(key)) {
				return fileError(reply, new FakeFileError("FILE_NOT_FOUND", "no such file"));
			}
			for (const [name, node] of tree) {
				if ((name === key || name.startsWith(`${key}/`)) && node.type === "file") {
					total += node.apparentSize ?? node.content.length;
				}
			}
		}
		if (total > MAX_DOWNLOAD_BYTES) {
			return fileError(
				reply,
				new FakeFileError("FILE_TOO_LARGE", "that download is over the size limit"),
			);
		}
		if (query.check === "1") return reply.status(204).send();
		if (paths.length > 1) {
			return reply
				.header("content-type", "application/zip")
				.send(oneFileZip("selection/README.md", "# selection\n"));
		}
		if (path !== "" && tree.get(nodeKey(slug, path))?.type !== "dir") {
			return fileError(reply, new FakeFileError("FILE_NOT_FOUND", "no such directory"));
		}
		const name = path === "" ? slug : path.split("/").slice(-1)[0];
		return reply
			.header("content-type", "application/zip")
			.send(oneFileZip(`${name}/README.md`, `# ${name}\n`));
	});

	// Test-only hooks: seed or remove a directory without going through the
	// API. "key" picks the workspace listing the bearer token would have.
	app.post("/__test/projects", async (request, reply) => {
		const body = request.body as { slug: string; isGitRepo?: boolean; key?: string };
		dirsForKey(body.key ?? "").set(body.slug, {
			isGitRepo: body.isGitRepo ?? true,
			directoryId: nextDirectoryId(),
		});
		return reply.status(204).send();
	});

	// Rename a directory the way `mv` in the shell does: the same directory
	// under a new name, so its identity is unchanged.
	app.post("/__test/projects/:slug/move", async (request, reply) => {
		const from = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const key = (request.query as { key?: string }).key ?? "";
		const here = dirsForKey(key);
		const directory = here.get(from);
		if (!directory) return projectNotFound(reply);
		here.delete(from);
		here.set(to, directory);
		rekeyTree(filesForKey(key), from, to, { copy: false });
		return reply.status(204).send();
	});

	app.get("/__test/projects", async (request) => {
		const key = (request.query as { key?: string }).key ?? "";
		return { slugs: [...dirsForKey(key).keys()] };
	});

	app.delete("/__test/projects/:slug", async (request, reply) => {
		const key = (request.query as { key?: string }).key ?? "";
		dirsForKey(key).delete((request.params as { slug: string }).slug);
		return reply.status(204).send();
	});
}
