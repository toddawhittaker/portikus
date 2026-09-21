import { basename } from "node:path";
import { Readable } from "node:stream";
import { requireUser } from "@portikus/auth";
import {
	CreateProjectRequest,
	contentDisposition,
	DeleteProjectRequest,
	DuplicateProjectRequest,
	type Project,
	ProjectLayout,
	type ProjectList,
	ProjectPath,
	ProjectState,
	type ProjectTemplateList,
	type SplitNode,
	slugify,
	UpdateProjectRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import {
	claimLongOperation,
	ownedProject as ownedProjectRow,
	ownedScope,
	type ProjectRow,
	projectPath,
	releaseLongOperation,
	requireAgent,
	type Scope,
	sendAgentError,
	sendError,
} from "./project-scope.js";

const ProjectParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });
const ListQuery = z.object({ state: ProjectState.default("active") });

/**
 * Most directories one listing will adopt as projects. The agent's listing is
 * untrusted input, so a workspace with thousands of directories must not turn
 * one page load into thousands of inserts (SPEC.md §24.6).
 */
const MAX_DISCOVERED_PROJECTS = 200;

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

/** Terminal panes in one layout tab, for the debug line on a save. */
function countPanes(node: SplitNode): number {
	if (node.type === "leaf") return 1;
	if (node.type !== "split") return 0;
	return node.children.reduce((total, child) => total + countPanes(child), 0);
}

/** One directory under `~/projects`, as the agent reported it. */
interface AgentDirectory {
	isGitRepo: boolean;
	directoryId: string | null;
}

/**
 * Follow projects whose directory was renamed in the shell (issue #238).
 *
 * The marker is the directory's inode, which `mv` keeps and which the agent
 * reports as `directoryId`. It was chosen over the alternatives because it
 * needs nothing written into the student's project, it works for a plain
 * folder as well as a repository, and it cannot be confused between two
 * clones of the same remote. A copy, or a restore from a recovery archive,
 * gets a new inode and is honestly a new project.
 *
 * Two passes, both cheap and idempotent, run before discovery on every
 * listing: first record the id of every directory a row already names, then
 * move any row whose directory is gone to the directory carrying its id.
 */
async function relocateMovedProjects(
	db: Kysely<Database>,
	workspaceId: string,
	directories: Map<string, AgentDirectory>,
): Promise<{ id: string; slug: string }[]> {
	const rows = await listRows(db, workspaceId).execute();

	// Pass one: learn the id of each directory a row still names. Only a blank
	// is filled in; a row that already carries a different id means two rows
	// disagree about one directory, which pass two sorts out.
	for (const row of rows) {
		const here = directories.get(row.slug);
		if (!here?.directoryId || row.directory_id !== null) continue;
		await db
			.updateTable("projects")
			.set({ directory_id: here.directoryId })
			.where("id", "=", row.id)
			.where("directory_id", "is", null)
			.execute();
		row.directory_id = here.directoryId;
	}

	// Pass two: a row whose directory is gone follows its id to the new slug.
	const claimed = new Set(rows.map((row) => row.slug));
	const byDirectoryId = new Map<string, string>();
	for (const [slug, dir] of directories) {
		if (dir.directoryId && !claimed.has(slug)) byDirectoryId.set(dir.directoryId, slug);
	}

	const moved: { id: string; slug: string }[] = [];
	for (const row of rows) {
		if (directories.has(row.slug) || row.directory_id === null) continue;
		const slug = byDirectoryId.get(row.directory_id);
		if (slug === undefined) continue;
		byDirectoryId.delete(row.directory_id);
		await moveProjectRow(db, row, slug);
		moved.push({ id: row.id, slug });
	}
	return moved;
}

/**
 * Point a project row at a directory that has a new name, and bring its
 * terminals' working directories along (SPEC.md §7.1, "Rename"). A project
 * still called after its old folder is renamed too, because that name was
 * never chosen by the student; a name the student typed is left alone.
 */
async function moveProjectRow(
	db: Kysely<Database>,
	row: ProjectRow,
	slug: string,
): Promise<void> {
	const oldPath = row.path;
	const newPath = projectPath(slug);
	const name = row.name === row.slug ? slug : row.name;
	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("projects")
			.set({ slug, name, path: newPath })
			.where("id", "=", row.id)
			.execute();
		const terminals = await trx
			.selectFrom("terminals")
			.selectAll()
			.where("project_id", "=", row.id)
			.execute();
		for (const terminal of terminals) {
			if (terminal.cwd !== oldPath && !terminal.cwd.startsWith(`${oldPath}/`)) continue;
			await trx
				.updateTable("terminals")
				.set({ cwd: newPath + terminal.cwd.slice(oldPath.length) })
				.where("id", "=", terminal.id)
				.execute();
		}
	});
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
	/** Every project route resolves its workspace through the one owner check. */
	function owned(request: FastifyRequest, reply: FastifyReply) {
		return ownedScope(db, config, request, reply);
	}

	/** The project row of this workspace, or null after answering 404. */
	function ownedProject(workspaceId: string, projectId: string, reply: FastifyReply) {
		return ownedProjectRow(db, workspaceId, projectId, reply);
	}

	// GET /workspaces/:id/projects -- rows reconciled with what the agent sees.
	app.get("/workspaces/:id/projects", async (request, reply) => {
		const scope = await owned(request, reply);
		if (!scope) return;
		const query = ListQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", query.error.message);
		}

		let directories: Map<string, AgentDirectory> | null = null;
		let truncated = false;
		if (scope.agent) {
			try {
				const listed = await scope.agent.listProjects();
				let entries = [...listed.projects].sort((a, b) => a.slug.localeCompare(b.slug));
				if (entries.length > MAX_DISCOVERED_PROJECTS) {
					request.log.warn(
						{ workspaceId: scope.workspaceId, count: entries.length },
						"project listing truncated",
					);
					entries = entries.slice(0, MAX_DISCOVERED_PROJECTS);
					truncated = true;
				}
				directories = new Map(
					entries.map((p) => [
						p.slug,
						{ isGitRepo: p.isGitRepo, directoryId: p.directoryId ?? null },
					]),
				);
			} catch {
				// A workspace whose agent is down still has projects to show.
				directories = null;
			}
		}

		// A project the student renamed with `mv` follows its directory to the
		// new slug, keeping its id, tabs and layout (issue #238).
		if (directories && query.data.state === "active") {
			const relocated = await relocateMovedProjects(db, scope.workspaceId, directories);
			for (const move of relocated) {
				request.log.info(
					{ workspaceId: scope.workspaceId, projectId: move.id, to: move.slug },
					"project followed its directory",
				);
			}
		}

		// Anything Git-enabled under ~/projects is a project (ADR 0010,
		// Discovery). Archiving does not remove the row, so an archived slug is
		// never re-added; that also means an archived listing discovers nothing.
		if (directories && query.data.state === "active") {
			// The pane polls every ten seconds, so read first and write only when
			// a directory is genuinely new (rows of any state count as known).
			const known = await db
				.selectFrom("projects")
				.select("slug")
				.where("workspace_id", "=", scope.workspaceId)
				.execute();
			const knownSlugs = new Set(known.map((row) => row.slug));
			const discovered = [...directories]
				.filter(([slug, dir]) => dir.isGitRepo && !knownSlugs.has(slug))
				.map(([slug, dir]) => ({
					workspace_id: scope.workspaceId,
					slug,
					name: slug,
					path: projectPath(slug),
					source: "discovered",
					directory_id: dir.directoryId,
				}));
			if (discovered.length > 0) {
				// One statement, and it still ignores conflicts, so two listings at
				// once cannot collide on the workspace and slug unique constraint.
				await db
					.insertInto("projects")
					.values(discovered)
					.onConflict((oc) => oc.columns(["workspace_id", "slug"]).doNothing())
					.execute();
			}
		}

		const rows = await listRows(db, scope.workspaceId)
			.where("state", "=", query.data.state)
			.execute();

		request.log.debug(
			{
				workspaceId: scope.workspaceId,
				rows: rows.length,
				discovered: directories ? directories.size : 0,
				missing: directories
					? rows.filter((row) => !directories.has(row.slug)).length
					: 0,
				truncated,
			},
			"project listing",
		);

		const body: ProjectList = {
			projects: rows.map((row) =>
				directories
					? toProject(
							row,
							directories.get(row.slug)?.isGitRepo ?? false,
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
		const agent = requireAgent(scope, reply);
		if (!agent) return;

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

		// An empty directory is quick; a clone or a template is not.
		const slow = body.data.source !== "new";
		if (slow && !claimLongOperation(scope.workspaceId, reply)) return;

		let created: { isGitRepo: boolean };
		try {
			created = await agent.createProject({
				slug,
				source: body.data.source,
				...(url === undefined ? {} : { url }),
				gitInit: body.data.gitInit,
			});
		} catch (error) {
			return sendAgentError(reply, error);
		} finally {
			if (slow) releaseLongOperation(scope.workspaceId);
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
				const agent = requireAgent(scope, reply);
				if (!agent) return;
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
					await agent.renameProject(current.slug, slug);
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

	// DELETE /workspaces/:id/projects/:pid -- permanent (SPEC.md §7.3, §24.11).
	app.delete("/workspaces/:id/projects/:pid", async (request, reply) => {
		const user = requireUser(request);
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const body = DeleteProjectRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		// Typing the folder name back is the whole safeguard, so it is checked
		// against the row rather than anything the browser chose.
		if (body.data.slug !== row.slug) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"The slug you typed does not match",
			);
		}
		const agent = requireAgent(scope, reply);
		if (!agent) return;

		// Removing a tree can take a while, and a copy running at the same time
		// would read directories this is deleting.
		if (!claimLongOperation(scope.workspaceId, reply)) return;
		try {
			return await deleteProjectTree(request, reply, scope, row, agent, user.id);
		} finally {
			releaseLongOperation(scope.workspaceId);
		}
	});

	/** The slow half of the delete, so the slot is released on every exit. */
	async function deleteProjectTree(
		request: FastifyRequest,
		reply: FastifyReply,
		scope: Scope,
		row: ProjectRow,
		agent: AgentClient,
		userId: string,
	): Promise<void> {
		// A terminal created in the directory that is about to go must end
		// first, or its shell keeps a deleted working directory (SPEC.md §9.3).
		// `terminals.cwd` is only the directory it started in, so one that
		// moved in or out of the project by `cd` is not matched.
		const open = await db
			.selectFrom("terminals")
			.selectAll()
			.where("workspace_id", "=", scope.workspaceId)
			.where("ended_at", "is", null)
			.execute();
		const inside = open.filter(
			(terminal) =>
				terminal.cwd === row.path || terminal.cwd.startsWith(`${row.path}/`),
		);
		for (const terminal of inside) {
			try {
				await agent.deleteTerminal(terminal.id);
			} catch (error) {
				// A session the agent has already lost is still an ended terminal.
				if (!(error instanceof AgentCallError)) throw error;
			}
			await db
				.updateTable("terminals")
				.set({ ended_at: new Date().toISOString() })
				.where("id", "=", terminal.id)
				.execute();
		}

		try {
			await agent.deleteProject(row.slug);
		} catch (error) {
			// A directory that is already gone still leaves a row to remove.
			const gone =
				error instanceof AgentCallError && error.code === "PROJECT_NOT_FOUND";
			if (!gone) return sendAgentError(reply, error);
		}

		await db.transaction().execute(async (trx) => {
			await trx.deleteFrom("projects").where("id", "=", row.id).execute();
			await trx
				.insertInto("audit_events")
				.values({
					actor: `user:${userId}`,
					target: row.id,
					action: "project.deleted",
					result: "ok",
					metadata: JSON.stringify({
						slug: row.slug,
						name: row.name,
						ip: request.ip,
					}),
				})
				.execute();
		});

		request.log.info(
			{ workspaceId: scope.workspaceId, projectId: row.id, slug: row.slug },
			"project deleted",
		);
		reply.status(204).send();
	}

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
		const agent = requireAgent(scope, reply);
		if (!agent) return;

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

		if (!claimLongOperation(scope.workspaceId, reply)) return;
		try {
			await agent.duplicateProject(row.slug, slug);
		} catch (error) {
			return sendAgentError(reply, error);
		} finally {
			releaseLongOperation(scope.workspaceId);
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
		const agent = requireAgent(scope, reply);
		if (!agent) return;
		try {
			await agent.gitInit(row.slug);
		} catch (error) {
			return sendAgentError(reply, error);
		}
		return toProject(row, true, false);
	});

	// GET /workspaces/:id/projects/:pid/download -- the agent's zip, streamed.
	// With `?path=` it is one directory inside the project (SPEC.md §11.2).
	app.get("/workspaces/:id/projects/:pid/download", async (request, reply) => {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const scope = await owned(request, reply);
		if (!scope) return;
		const row = await ownedProject(scope.workspaceId, params.data.pid, reply);
		if (!row) return;
		const agent = requireAgent(scope, reply);
		if (!agent) return;

		// The path is checked here as well as in the agent, so a traversal
		// attempt never leaves the control plane (SPEC.md §11.1, §24.6).
		const asked = (request.query as { path?: unknown }).path;
		let subPath = "";
		if (asked !== undefined && asked !== "") {
			const parsed = typeof asked === "string" ? ProjectPath.safeParse(asked) : null;
			if (!parsed?.success) {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"that path is not inside the project",
				);
			}
			subPath = parsed.data;
		}

		// Zipping runs while the response streams, so the slot is held until the
		// response is done, not just until the headers come back.
		if (!claimLongOperation(scope.workspaceId, reply)) return;
		const release = () => releaseLongOperation(scope.workspaceId);

		let upstream: Response;
		try {
			upstream = await agent.downloadProject(row.slug, subPath);
		} catch (error) {
			release();
			return sendAgentError(reply, error);
		}
		if (!upstream.body) {
			release();
			return sendError(reply, 503, "AGENT_UNAVAILABLE", "The archive was empty.");
		}

		const stream = Readable.fromWeb(upstream.body as never);
		stream.on("close", release);
		stream.on("error", release);

		// The name is the slug, or the directory that was asked for; either way
		// it is escaped rather than sent through as typed.
		const name = subPath === "" ? row.slug : basename(subPath);
		reply.header("content-type", "application/zip");
		reply.header("content-disposition", contentDisposition(`${name}.zip`));
		return reply.send(stream);
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

		request.log.debug(
			{
				workspaceId: scope.workspaceId,
				projectId: row.id,
				tabs: body.data.tabs.length,
				panes: body.data.tabs.reduce((total, tab) => total + countPanes(tab.root), 0),
			},
			"layout saved",
		);

		return reply.status(204).send();
	});
}
