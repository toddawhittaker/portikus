import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type Database, recordAudit, recordNotification } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { type AgentClient, agentClientFor } from "../agent-client.js";
import { sharesCourseWith } from "../courses/membership.js";
import { sendError } from "../http.js";

const SharedParam = z.object({
	courseId: z.string().uuid(),
	projectId: z.string().uuid(),
});

/** The shared project one read works against. */
export interface SharedScope {
	agent: AgentClient;
	slug: string;
}

/** Title of the notice a student gets on each instructor's first view. */
export const SHARE_VIEWED_TITLE = "An instructor opened your shared project";

/**
 * The single gate every shared read goes through (SPEC.md §5.2, ADR 0057):
 * the viewer teaches the course, the owner is a member of it, the share is
 * open and unexpired, and the project is active. Anything else is 404, the
 * same answer as a project that does not exist. Returns null after answering.
 *
 * It never opens presence and never asks for a start, so a view neither
 * keeps a workspace running nor wakes a stopped one.
 */
export async function sharedProject(
	db: Kysely<Database>,
	config: ApiConfig,
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<SharedScope | null> {
	const viewer = requireUser(request);
	const params = SharedParam.safeParse(request.params);
	if (!params.success) {
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return null;
	}
	const { courseId, projectId } = params.data;

	const row = await db
		.selectFrom("project_shares")
		.innerJoin("projects", "projects.id", "project_shares.project_id")
		.innerJoin("workspaces", "workspaces.id", "projects.workspace_id")
		.select([
			"project_shares.id as share_id",
			"projects.slug",
			"projects.name",
			"workspaces.owner_user_id",
			"workspaces.state",
			"workspaces.agent_address",
			"workspaces.agent_token",
		])
		.where("project_shares.project_id", "=", projectId)
		.where("project_shares.ended_at", "is", null)
		.where("project_shares.ends_at", ">", sql<Date>`now()`)
		.where("projects.state", "=", "active")
		.executeTakeFirst();
	const allowed =
		row !== undefined &&
		(await sharesCourseWith(db, {
			instructorId: viewer.id,
			memberId: row.owner_user_id,
			courseId,
		}));
	if (!row || !allowed) {
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return null;
	}

	if (row.state !== "running") {
		sendError(reply, 409, "WORKSPACE_NOT_RUNNING", "The workspace is stopped");
		return null;
	}
	const agent = agentClientFor(row, config.AGENT_PORT);
	if (!agent) {
		sendError(reply, 503, "AGENT_UNAVAILABLE", "The workspace agent is not reachable.");
		return null;
	}

	await recordView(db, {
		shareId: row.share_id,
		projectId,
		projectName: row.name,
		ownerId: row.owner_user_id,
		courseId,
		viewer: { id: viewer.id, displayName: viewer.displayName },
	});
	return { agent, slug: row.slug };
}

/**
 * Note one read by an instructor. The first view of each share by each
 * instructor is audited and tells the student; later ones only move
 * `last_viewed_at` (SPEC.md §24.11, ADR 0057).
 */
async function recordView(
	db: Kysely<Database>,
	view: {
		shareId: string;
		projectId: string;
		projectName: string;
		ownerId: string;
		courseId: string;
		viewer: { id: string; displayName: string };
	},
): Promise<void> {
	await db.transaction().execute(async (trx) => {
		const first = await trx
			.insertInto("project_share_views")
			.values({ share_id: view.shareId, viewer_user_id: view.viewer.id })
			.onConflict((oc) => oc.columns(["share_id", "viewer_user_id"]).doNothing())
			.returning("share_id")
			.executeTakeFirst();
		if (!first) {
			await trx
				.updateTable("project_share_views")
				.set({ last_viewed_at: sql<string>`now()` })
				.where("share_id", "=", view.shareId)
				.where("viewer_user_id", "=", view.viewer.id)
				.execute();
			return;
		}
		// Ids only: no names or paths (ADR 0012).
		await recordAudit(trx, {
			actor: `user:${view.viewer.id}`,
			target: view.projectId,
			action: "project.share_viewed",
			result: "ok",
			metadata: { shareId: view.shareId, contextId: view.courseId },
		});
		await recordNotification(trx, view.ownerId, {
			tone: "neutral",
			title: SHARE_VIEWED_TITLE,
			body: `${view.viewer.displayName} opened ${view.projectName}.`,
		});
	});
}
