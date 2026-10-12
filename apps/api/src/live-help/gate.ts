import { requireUser } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { CloseCode, type TerminalAttachMode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { type AgentClient, agentClientFor } from "../agent-client.js";
import { sharesCourseWith } from "../courses/membership.js";
import { sendError } from "../http.js";
import { countActive, type WorkspaceRow } from "../workspaces/workspace-view.js";
import { endLiveHelp } from "./sessions.js";

const SessionParam = z.object({
	courseId: z.string().uuid(),
	sid: z.string().uuid(),
});

/** One open live help session, as the gate let its helper through. */
export interface LiveHelpScope {
	sessionId: string;
	workspaceId: string;
	projectId: string;
	projectName: string;
	ownerId: string;
	helperId: string;
	courseId: string;
	typing: boolean;
	startedAt: Date;
	endsAt: Date;
	workspace: WorkspaceRow;
	/** Set only when the gate was asked for a live workspace. */
	agent: AgentClient | null;
}

type Found = Omit<LiveHelpScope, "agent">;

/**
 * The session `sessionId` of `helperId` in `courseId`, when it is open,
 * unexpired, on an active project, and the helper still teaches a course the
 * student belongs to. A session whose course link broke is ended here, so a
 * roster change ends it on the next check (ADR 0063).
 */
async function findLiveHelp(
	db: Kysely<Database>,
	ids: { sessionId: string; helperId: string; courseId: string },
): Promise<Found | null> {
	const row = await db
		.selectFrom("live_help_sessions")
		.innerJoin("projects", "projects.id", "live_help_sessions.project_id")
		.innerJoin("workspaces", "workspaces.id", "live_help_sessions.workspace_id")
		.selectAll("workspaces")
		.select([
			"live_help_sessions.id as session_id",
			"live_help_sessions.typing",
			"live_help_sessions.started_at",
			"live_help_sessions.ends_at",
			"projects.id as project_id",
			"projects.name as project_name",
			"projects.state as project_state",
		])
		.where("live_help_sessions.id", "=", ids.sessionId)
		.where("live_help_sessions.helper_user_id", "=", ids.helperId)
		.where("live_help_sessions.course_id", "=", ids.courseId)
		.where("live_help_sessions.ended_at", "is", null)
		.where("live_help_sessions.ends_at", ">", sql<Date>`now()`)
		.executeTakeFirst();
	if (row?.project_state !== "active") return null;
	const allowed = await sharesCourseWith(db, {
		instructorId: ids.helperId,
		memberId: row.owner_user_id,
		courseId: ids.courseId,
	});
	if (!allowed) {
		await endLiveHelp(db, {
			sessionId: row.session_id,
			actor: "platform",
			reason: "helper_removed",
		});
		return null;
	}
	const {
		session_id,
		typing,
		started_at,
		ends_at,
		project_id,
		project_name,
		project_state: _state,
		...workspace
	} = row;
	return {
		sessionId: session_id,
		workspaceId: workspace.id,
		projectId: project_id,
		projectName: project_name,
		ownerId: workspace.owner_user_id,
		helperId: ids.helperId,
		courseId: ids.courseId,
		typing,
		startedAt: started_at,
		endsAt: ends_at,
		workspace,
	};
}

/**
 * The single gate every instructor live help route and socket goes through
 * (ADR 0063). Anyone but the session's helper, and any session that is not
 * open, gets 404, the answer for a session that does not exist. With `live`,
 * a stopped workspace or a student with no browser open is 409 (D6 in the
 * plan, SPEC.md §6.4: the helper never keeps the workspace awake). Returns
 * null after answering.
 */
export async function liveHelpScope(
	db: Kysely<Database>,
	config: ApiConfig,
	request: FastifyRequest,
	reply: FastifyReply,
	options: { live: boolean },
): Promise<LiveHelpScope | null> {
	const helper = requireUser(request);
	const params = SessionParam.safeParse(request.params);
	if (!params.success) {
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return null;
	}
	const found = await findLiveHelp(db, {
		sessionId: params.data.sid,
		helperId: helper.id,
		courseId: params.data.courseId,
	});
	if (!found) {
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return null;
	}
	if (!options.live) return { ...found, agent: null };

	if (found.workspace.state !== "running") {
		sendError(reply, 409, "WORKSPACE_NOT_RUNNING", "The workspace is stopped");
		return null;
	}
	if ((await countActive(db, found.workspaceId, config)) === 0) {
		sendError(
			reply,
			409,
			"STUDENT_NOT_CONNECTED",
			"The student does not have their workspace open.",
		);
		return null;
	}
	const agent = agentClientFor(found.workspace, config.AGENT_PORT);
	if (!agent) {
		sendError(reply, 503, "AGENT_UNAVAILABLE", "The workspace agent is not reachable.");
		return null;
	}
	return { ...found, agent };
}

/**
 * The once-a-second check of an open helper socket: the close it needs, or
 * null while the session still allows it in this mode (ADR 0063).
 */
export async function helperSocketRefusal(
	db: Kysely<Database>,
	config: ApiConfig,
	scope: Pick<LiveHelpScope, "sessionId" | "helperId" | "courseId" | "workspaceId">,
	mode: TerminalAttachMode,
): Promise<{ code: number; reason: string } | null> {
	const found = await findLiveHelp(db, scope);
	if (!found) return { code: CloseCode.LIVE_HELP_ENDED, reason: "live help ended" };
	if ((found.typing ? "type" : "view") !== mode) {
		return { code: CloseCode.LIVE_HELP_MODE_CHANGED, reason: "live help mode changed" };
	}
	if (found.workspace.state !== "running") {
		return { code: CloseCode.POLICY, reason: "workspace stopped" };
	}
	if ((await countActive(db, scope.workspaceId, config)) === 0) {
		return { code: CloseCode.POLICY, reason: "student not connected" };
	}
	return null;
}
