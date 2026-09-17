import { Readable } from "node:stream";
import { requireUser } from "@portikus/auth";
import {
	type ApiError,
	type ApiErrorCode,
	CreateProjectRequest,
	DuplicateProjectRequest,
	type Project,
	ProjectLayout,
	type ProjectList,
	ProjectState,
	type ProjectTemplateList,
	slugify,
	UpdateProjectRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { AgentCallError, type AgentClient, agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { findWorkspaceOwnedBy } from "./workspace-view.js";

const WorkspaceParam = z.object({ id: z.string().uuid() });
const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });
const ListQuery = z.object({ state: ProjectState.default("active") });

/** Where every project directory lives inside the workspace (SPEC.md §7.1). */
const PROJECTS_ROOT = "/home/student/projects";

type ProjectRow = Selectable<Database["projects"]>;

function projectPath(slug: string): string {
	return `${PROJECTS_ROOT}/${slug}`;
}

function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiErrorCode,
	message: string,
): void {
	const body: ApiError = { code, message };
	reply.status(statusCode).send(body);
}

/** The status and code each agent error becomes (SPEC.md §27). */
const AGENT_ERROR_STATUS: Partial<Record<string, [number, ApiErrorCode]>> = {
	PROJECT_EXISTS: [409, "PROJECT_EXISTS"],
	PROJECT_NOT_FOUND: [404, "PROJECT_NOT_FOUND"],
	INVALID_SLUG: [400, "INVALID_SLUG"],
	INVALID_URL: [400, "INVALID_URL"],
	GIT_FAILED: [400, "GIT_FAILED"],
};

/** Report an agent failure to the browser; anything else is a real error. */
function sendAgentError(reply: FastifyReply, error: unknown): void {
	if (!(error instanceof AgentCallError)) throw error;
	const mapped = AGENT_ERROR_STATUS[error.code];
	if (mapped) {
		sendError(reply, mapped[0], mapped[1], error.message);
		return;
	}
	sendError(
		reply,
		503,
		"AGENT_UNAVAILABLE",
		"The workspace agent could not be reached.",
	);
}

function toProject(
	row: ProjectRow,
	isGitRepo: boolean | null,
	missing: boolean | null,
): Project {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		slug: row.slug,
		name: row.name,
		path: row.path,
		state: row.state as Project["state"],
		source: row.source as Project["source"],
		isGitRepo,
		missing,
		createdAt: row.created_at.toISOString(),
		archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
	};
}

function listRows(db: Kysely<Database>, workspaceId: string) {
	return db
		.selectFrom("projects")
		.selectAll()
		.where("workspace_id", "=", workspaceId)
		.orderBy("created_at");
}

/**
 * Project management (SPEC.md §7, §26). The database row is the record; the
 * directory under `~/projects` belongs to the workspace agent, which the API
 * drives with the per-workspace bearer token (ADR 0009).
 */
export function registerProjectRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	/**
	 * Load the workspace for its owner, plus an agent client when the workspace
	 * is running. Returns null after answering, so callers just return.
	 */
	async function owned(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<{ workspaceId: string; agent: AgentClient | null } | null> {
		const user = requireUser(request);
		const params = WorkspaceParam.safeParse(request.params);
		if (!params.success) {
			sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
			return null;
		}
		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
			return null;
		}
		const agent = agentClientFor(workspace, config.AGENT_PORT);
		return {
			workspaceId: params.data.id,
			agent: workspace.state === "running" ? agent : null,
		};
	}

	/** The project row of this workspace, or null after answering 404. */
	async function ownedProject(
		workspaceId: string,
		projectId: string,
		reply: FastifyReply,
	): Promise<ProjectRow | null> {
		const row = await db
			.selectFrom("projects")
			.selectAll()
			.where("id", "=", projectId)
			.where("workspace_id", "=", workspaceId)
			.executeTakeFirst();
		if (!row) {
			sendError(reply, 404, "PROJECT_NOT_FOUND", "Project not found");
			return null;
		}
		return row;
	}

	// GET /workspaces/:id/projects -- rows reconciled with what the agent sees.
	app.get("/workspaces/:id/projects", async (request, reply) => {
		const scope = await owned(request, reply);
		if (!scope) return;
		const query = ListQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", query.error.message);
		}

		let directories: Map<string, boolean> | null = null;
		if (scope.agent) {
			try {
				const listed = await scope.agent.listProjects();
				directories = new Map(listed.projects.map((p) => [p.slug, p.isGitRepo]));
			} catch {
				// A workspace whose agent is down still has projects to show.
				directories = null;
			}
		}

		if (directories) {
			// Anything Git-enabled under ~/projects is a project (plan, Discovery).
			// An archived slug already has a row, so it is never re-added.
			const known = new Set(
				(await listRows(db, scope.workspaceId).select("slug").execute()).map(
					(row) => row.slug,
				),
			);
			for (const [slug, isGitRepo] of directories) {
				if (!isGitRepo || known.has(slug)) continue;
				await db
					.insertInto("projects")
					.values({
						workspace_id: scope.workspaceId,
						slug,
						name: slug,
						path: projectPath(slug),
						source: "discovered",
					})
					.execute();
			}
		}

		const rows = await listRows(db, scope.workspaceId)
			.where("state", "=", query.data.state)
			.execute();
		const body: ProjectList = {
			projects: rows.map((row) =>
				directories
					? toProject(
							row,
							directories.get(row.slug) ?? false,
							!directories.has(row.slug),
						)
					: toProject(row, null, null),
			),
		};
		return body;
	});

	// Registered before /:pid so "templates" is not read as a project id.
	app.get("/workspaces/:id/projects/templates", async (request, reply) => {
		const scope = await owned(request, reply);
		if (!scope) return;
		const body: ProjectTemplateList = { templates: config.projectTemplates };
		return body;
	});

	// POST /workspaces/:id/projects (SPEC.md §7.2).
	app.post("/workspaces/:id/projects", async (request, reply) => {
		const scope = await owned(request, reply);
		if (!scope) return;
		const body = CreateProjectRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		if (!scope.agent) {
			return sendError(
				reply,
				409,
				"AGENT_UNAVAILABLE",
				"The workspace is not running yet. Start it and try again.",
			);
		}

		const slug = slugify(body.data.name);
		if (slug === "") {
			return sendError(
				reply,
				400,
				"INVALID_SLUG",
				"The project name must contain a letter or a digit.",
			);
		}

		let url = body.data.url;
		if (body.data.source === "template") {
			const template = config.projectTemplates.find(
				(candidate) => candidate.name === body.data.template,
			);
			if (!template) {
				return sendError(reply, 400, "VALIDATION_FAILED", "Unknown project template");
			}
			url = template.url;
		}

		const existing = await db
			.selectFrom("projects")
			.select("id")
			.where("workspace_id", "=", scope.workspaceId)
			.where("slug", "=", slug)
			.executeTakeFirst();
		if (existing) {
			return sendError(
				reply,
				409,
				"PROJECT_EXISTS",
				`A project called ${slug} already exists.`,
			);
		}

		let created: { isGitRepo: boolean };
		try {
			created = await scope.agent.createProject({
				slug,
				source: body.data.source,
				...(url === undefined ? {} : { url }),
				gitInit: body.data.gitInit,
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}

		const row = await db
			.insertInto("projects")
			.values({
				workspace_id: scope.workspaceId,
				slug,
				name: body.data.name,
				path: projectPath(slug),
				source: body.data.source,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return reply.status(201).send(toProject(row, created.isGitRepo, false));
	});

	// PATCH /workspaces/:id/projects/:pid -- rename, archive, unarchive.
	app.patch("/workspaces/:id/projects/:pid", async (request, reply) => {
		const user = requireUser(request);
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const body = UpdateProjectRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;

		let current = row;

		if (body.data.name !== undefined && body.data.name !== current.name) {
			const slug = slugify(body.data.name);
			if (slug === "") {
				return sendError(
					reply,
					400,
					"INVALID_SLUG",
					"The project name must contain a letter or a digit.",
				);
			}
			if (slug !== current.slug) {
				if (!scope.agent) {
					return sendError(
						reply,
						409,
						"AGENT_UNAVAILABLE",
						"The workspace is not running yet. Start it and try again.",
					);
				}
				const taken = await db
					.selectFrom("projects")
					.select("id")
					.where("workspace_id", "=", scope.workspaceId)
					.where("slug", "=", slug)
					.executeTakeFirst();
				if (taken) {
					return sendError(
						reply,
						409,
						"PROJECT_EXISTS",
						`A project called ${slug} already exists.`,
					);
				}
				try {
					await scope.agent.renameProject(current.slug, slug);
				} catch (error) {
					return sendAgentError(reply, error);
				}
			}

			const oldPath = current.path;
			const newPath = projectPath(slug);
			current = await db.transaction().execute(async (trx) => {
				const updated = await trx
					.updateTable("projects")
					.set({ slug, name: body.data.name as string, path: newPath })
					.where("id", "=", current.id)
					.returningAll()
					.executeTakeFirstOrThrow();
				// A terminal's cwd is a path under the project that just moved.
				const terminals = await trx
					.selectFrom("terminals")
					.selectAll()
					.where("project_id", "=", current.id)
					.execute();
				for (const terminal of terminals) {
					if (terminal.cwd !== oldPath && !terminal.cwd.startsWith(`${oldPath}/`)) {
						continue;
					}
					await trx
						.updateTable("terminals")
						.set({ cwd: newPath + terminal.cwd.slice(oldPath.length) })
						.where("id", "=", terminal.id)
						.execute();
				}
				return updated;
			});
		}

		if (body.data.state !== undefined && body.data.state !== current.state) {
			const archiving = body.data.state === "archived";
			current = await db
				.updateTable("projects")
				.set({
					state: body.data.state,
					archived_at: archiving ? new Date().toISOString() : null,
				})
				.where("id", "=", current.id)
				.returningAll()
				.executeTakeFirstOrThrow();
			await db
				.insertInto("audit_events")
				.values({
					actor: `user:${user.id}`,
					target: current.id,
					action: archiving ? "project.archived" : "project.unarchived",
					result: "ok",
				})
				.execute();
		}

		return toProject(current, null, null);
	});

	// POST /workspaces/:id/projects/:pid/duplicate (SPEC.md §7.3).
	app.post("/workspaces/:id/projects/:pid/duplicate", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const body = DuplicateProjectRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		if (!scope.agent) {
			return sendError(
				reply,
				409,
				"AGENT_UNAVAILABLE",
				"The workspace is not running yet. Start it and try again.",
			);
		}

		const slug = slugify(body.data.name);
		if (slug === "") {
			return sendError(
				reply,
				400,
				"INVALID_SLUG",
				"The project name must contain a letter or a digit.",
			);
		}
		const taken = await db
			.selectFrom("projects")
			.select("id")
			.where("workspace_id", "=", scope.workspaceId)
			.where("slug", "=", slug)
			.executeTakeFirst();
		if (taken) {
			return sendError(
				reply,
				409,
				"PROJECT_EXISTS",
				`A project called ${slug} already exists.`,
			);
		}

		try {
			await scope.agent.duplicateProject(row.slug, slug);
		} catch (error) {
			return sendAgentError(reply, error);
		}

		// The copy is a project the student made here, not a discovered one.
		const copy = await db
			.insertInto("projects")
			.values({
				workspace_id: scope.workspaceId,
				slug,
				name: body.data.name,
				path: projectPath(slug),
				source: "new",
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return reply.status(201).send(toProject(copy, null, false));
	});

	// POST /workspaces/:id/projects/:pid/git-init (SPEC.md §7.2).
	app.post("/workspaces/:id/projects/:pid/git-init", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		if (!scope.agent) {
			return sendError(
				reply,
				409,
				"AGENT_UNAVAILABLE",
				"The workspace is not running yet. Start it and try again.",
			);
		}
		try {
			await scope.agent.gitInit(row.slug);
		} catch (error) {
			return sendAgentError(reply, error);
		}
		return toProject(row, true, false);
	});

	// GET /workspaces/:id/projects/:pid/download -- the agent's zip, streamed.
	app.get("/workspaces/:id/projects/:pid/download", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		if (!scope.agent) {
			return sendError(
				reply,
				409,
				"AGENT_UNAVAILABLE",
				"The workspace is not running yet. Start it and try again.",
			);
		}

		let upstream: Response;
		try {
			upstream = await scope.agent.downloadProject(row.slug);
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!upstream.body) {
			return sendError(reply, 503, "AGENT_UNAVAILABLE", "The archive was empty.");
		}

		// The filename is the slug, never anything the student typed.
		reply.header("content-type", "application/zip");
		reply.header("content-disposition", `attachment; filename="${row.slug}.zip"`);
		return reply.send(Readable.fromWeb(upstream.body as never));
	});

	// GET /workspaces/:id/projects/:pid/layout (SPEC.md §7.5).
	app.get("/workspaces/:id/projects/:pid/layout", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		if (row.layout === null) return reply.status(204).send();
		return row.layout;
	});

	// PUT /workspaces/:id/projects/:pid/layout -- last write wins (plan, Layout).
	app.put("/workspaces/:id/projects/:pid/layout", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const body = ProjectLayout.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;

		await db
			.updateTable("projects")
			.set({ layout: JSON.stringify(body.data) })
			.where("id", "=", row.id)
			.execute();
		return reply.status(204).send();
	});
}
