import { requireUser } from "@portikus/auth";
import { type ProjectShareStatus, SHARE_DURATION_HOURS } from "@portikus/contracts";
import { type Database, isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import type { ServerDeps } from "../deps.js";
import { ProjectParam, sendError } from "../http.js";
import {
	ownedProject,
	ownedScope,
	type ProjectRow,
} from "../workspaces/project-scope.js";
import { closeExpired, stopShare } from "../workspaces/project-share.js";

/** The open, unexpired share of a project and who has looked, earliest first. */
async function shareStatus(
	db: Kysely<Database>,
	projectId: string,
): Promise<ProjectShareStatus> {
	const share = await db
		.selectFrom("project_shares")
		.select(["id", "started_at", "ends_at"])
		.where("project_id", "=", projectId)
		.where("ended_at", "is", null)
		.where("ends_at", ">", sql<Date>`now()`)
		.executeTakeFirst();
	if (!share) return { share: null, viewers: [] };
	const viewers = await db
		.selectFrom("project_share_views")
		.innerJoin("users", "users.id", "project_share_views.viewer_user_id")
		.select([
			"users.display_name",
			"project_share_views.first_viewed_at",
			"project_share_views.last_viewed_at",
		])
		.where("project_share_views.share_id", "=", share.id)
		.orderBy("project_share_views.first_viewed_at")
		.execute();
	return {
		share: {
			id: share.id,
			startedAt: new Date(share.started_at).toISOString(),
			endsAt: new Date(share.ends_at).toISOString(),
		},
		viewers: viewers.map((row) => ({
			displayName: row.display_name,
			firstViewedAt: new Date(row.first_viewed_at).toISOString(),
			lastViewedAt: new Date(row.last_viewed_at).toISOString(),
		})),
	};
}

/**
 * A student starts, reads and stops the read-only share of one project with
 * the instructors of their courses (SPEC.md §5.2, ADR 0057). Only the owner
 * reaches these; an administrator or instructor gets the owner routes' 404.
 */
export function registerProjectShareRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;

	/** The owner's project, or null after answering. */
	async function ownProject(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<ProjectRow | null> {
		const params = ProjectParam.safeParse(request.params);
		if (!params.success) {
			sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
			return null;
		}
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return null;
		return ownedProject(db, scope.workspaceId, params.data.pid, reply);
	}

	app.get("/workspaces/:id/projects/:pid/share", async (request, reply) => {
		const project = await ownProject(request, reply);
		if (!project) return;
		return shareStatus(db, project.id);
	});

	// Starting again while a share is open keeps that share as it is.
	app.post("/workspaces/:id/projects/:pid/share", async (request, reply) => {
		const user = requireUser(request);
		const project = await ownProject(request, reply);
		if (!project) return;
		if (project.state !== "active") {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"An archived project cannot be shared.",
			);
		}
		try {
			await db.transaction().execute(async (trx) => {
				await closeExpired(trx, project.id);
				const open = await trx
					.selectFrom("project_shares")
					.select("id")
					.where("project_id", "=", project.id)
					.where("ended_at", "is", null)
					.executeTakeFirst();
				if (open) return;
				// The database clock, the one every expiry check compares with.
				const share = await trx
					.insertInto("project_shares")
					.values({
						project_id: project.id,
						ends_at: sql<string>`now() + make_interval(hours => ${SHARE_DURATION_HOURS})`,
					})
					.returning("id")
					.executeTakeFirstOrThrow();
				await recordAudit(trx, {
					actor: `user:${user.id}`,
					target: project.id,
					action: "project.share_started",
					result: "ok",
					metadata: { shareId: share.id },
				});
			});
		} catch (error) {
			// A second start that raced this one already opened the share.
			if (!isUniqueViolation(error, "project_shares_one_open")) throw error;
		}
		return shareStatus(db, project.id);
	});

	app.post("/workspaces/:id/projects/:pid/share/stop", async (request, reply) => {
		const user = requireUser(request);
		const project = await ownProject(request, reply);
		if (!project) return;
		await db.transaction().execute((trx) =>
			stopShare(trx, {
				projectId: project.id,
				actor: `user:${user.id}`,
				reason: "stopped",
			}),
		);
		return shareStatus(db, project.id);
	});
}
