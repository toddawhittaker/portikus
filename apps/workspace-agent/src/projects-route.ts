import {
	AgentCreateProjectRequest,
	AgentDuplicateProjectRequest,
	AgentRenameProjectRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { sendError } from "./errors.js";
import {
	createProject,
	deleteProject,
	duplicateProject,
	getProject,
	gitInitProject,
	listProjects,
	renameProject,
} from "./projects.js";

/** The project routes (SPEC.md §9.7). */
export async function projectsRoutes(
	instance: FastifyInstance,
	options: { homeDir: string },
): Promise<void> {
	const { homeDir } = options;
	instance.get("/projects", async (request, reply) => {
		try {
			return { projects: await listProjects(homeDir) };
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get("/projects/:slug", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			return await getProject(slug, homeDir);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects", async (request, reply) => {
		const parsed = AgentCreateProjectRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply.code(400).send({
				error: {
					code: "INVALID_SLUG",
					message: parsed.error.issues.map((issue) => issue.message).join("; "),
				},
			});
		}
		try {
			const project = await createProject(parsed.data, homeDir);
			request.log.debug(
				{ slug: project.slug, operation: "create", source: parsed.data.source },
				"project operation",
			);
			return reply.code(201).send(project);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.delete("/projects/:slug", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			await deleteProject(slug, homeDir);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
		request.log.info({ slug, operation: "delete" }, "project deleted");
		return reply.code(204).send();
	});

	instance.post("/projects/:slug/rename", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const parsed = AgentRenameProjectRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "INVALID_SLUG", message: "invalid target slug" } });
		}
		try {
			const project = await renameProject(slug, parsed.data.to, homeDir);
			request.log.debug(
				{ slug, operation: "rename", to: project.slug },
				"project operation",
			);
			return project;
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/duplicate", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		const parsed = AgentDuplicateProjectRequest.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.code(400)
				.send({ error: { code: "INVALID_SLUG", message: "invalid target slug" } });
		}
		try {
			const project = await duplicateProject(slug, parsed.data.to, homeDir);
			request.log.debug(
				{ slug, operation: "duplicate", to: project.slug },
				"project operation",
			);
			return project;
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/git-init", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const project = await gitInitProject(slug, homeDir);
			request.log.debug({ slug, operation: "git-init" }, "project operation");
			return project;
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});
}
