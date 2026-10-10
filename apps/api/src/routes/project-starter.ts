import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import {
	type CreateProjectRequest,
	StarterProjectRequest,
	type StarterProjectResponse,
	slugify,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { sendError } from "../http.js";
import { consumeStarterLaunch, findStarterLaunch } from "../lti/starter.js";
import { createProject } from "../workspaces/create-project.js";
import { ownedScope, toProject } from "../workspaces/project-scope.js";

/**
 * Open the project a Deep Linking link names (ADR 0058, SPEC.md §7.2). It is
 * created only when no project of the workspace has its slug; otherwise the
 * existing one, active or archived, is returned as it is. Never overwrites.
 */
export function registerProjectStarterRoute(
	app: FastifyInstance,
	db: Kysely<Database>,
	config: ApiConfig,
	limitWrites: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
	app.post(
		"/workspaces/:id/projects/starter",
		{ preHandler: limitWrites },
		async (request, reply) => {
			const scope = await ownedScope(db, config, request, reply);
			if (!scope) return;
			const body = StarterProjectRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
			}
			// Another user's starter, an expired one and a used one all look alike.
			const starter = await findStarterLaunch(
				db,
				body.data.starterId,
				requireUser(request).id,
			);
			if (!starter) {
				return sendError(
					reply,
					404,
					"NOT_FOUND",
					"This course link has expired. Open it again from your course.",
				);
			}

			const existing = await db
				.selectFrom("projects")
				.selectAll()
				.where("workspace_id", "=", scope.workspaceId)
				.where("slug", "=", slugify(starter.project_name))
				.executeTakeFirst();
			if (existing) {
				await consumeStarterLaunch(db, starter.id);
				request.log.info(
					{ workspaceId: scope.workspaceId, projectId: existing.id },
					"starter opened an existing project",
				);
				const answer: StarterProjectResponse = {
					project: toProject(existing, null, null),
					created: false,
				};
				return answer;
			}

			const input: CreateProjectRequest =
				starter.template !== null
					? {
							name: starter.project_name,
							source: "template",
							template: starter.template,
							gitInit: true,
						}
					: {
							name: starter.project_name,
							source: "clone",
							url: starter.repository_url ?? "",
							gitInit: true,
						};
			const created = await createProject(db, config, scope, reply, input);
			// A refusal keeps the starter, so the student can try again once the cause is gone.
			if (!created) return;
			await consumeStarterLaunch(db, starter.id);
			const answer: StarterProjectResponse = {
				project: toProject(created.row, created.isGitRepo, false),
				created: true,
			};
			return reply.status(201).send(answer);
		},
	);
}
