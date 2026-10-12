import { requireUser } from "@portikus/auth";
import { LiveHelpTypingRequest, StartLiveHelpRequest } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../deps.js";
import { ProjectParam, parseOr400, sendError } from "../http.js";
import {
	liveHelpStatus,
	setLiveHelpTyping,
	startLiveHelp,
	stopLiveHelp,
} from "../live-help/sessions.js";
import type { UserLimit } from "../rate-limit.js";
import { ownedProject, ownedScope } from "../workspaces/project-scope.js";

/**
 * A student starts, reads, changes and ends live help on their own
 * workspace (ADR 0063). Only the owner reaches these; an administrator or
 * instructor gets the owner routes' 404. Every answer is the student's
 * `LiveHelpStatus`; the GET names the instructors to ask only with
 * `?audience=1`, which the start dialog sends and the bar's poll does not.
 */
export function registerLiveHelpRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
	/** Shared with the other per-user writes (SPEC.md §24.13). */
	allowWrite: UserLimit,
): void {
	const { db, config } = deps;
	const withAudience = { audience: true };

	async function limitWrites(request: FastifyRequest, reply: FastifyReply) {
		if (!(await allowWrite(request, reply))) return reply;
	}

	app.get("/workspaces/:id/live-help", async (request, reply) => {
		const user = requireUser(request);
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const audience = (request.query as { audience?: unknown } | undefined)?.audience;
		return liveHelpStatus(db, scope.workspaceId, user.id, {
			audience: audience === "1",
		});
	});

	app.post(
		"/workspaces/:id/projects/:pid/live-help",
		{ preHandler: limitWrites },
		async (request, reply) => {
			const user = requireUser(request);
			const params = parseOr400(ProjectParam, request.params, reply);
			if (!params) return;
			const scope = await ownedScope(db, config, request, reply);
			if (!scope) return;
			const project = await ownedProject(db, scope.workspaceId, params.pid, reply);
			if (!project) return;
			const body = parseOr400(StartLiveHelpRequest, request.body, reply);
			if (!body) return;
			if (project.state !== "active") {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"Live help cannot start on an archived project.",
				);
			}
			const result = await startLiveHelp(db, {
				workspaceId: scope.workspaceId,
				projectId: project.id,
				projectName: project.name,
				owner: { id: user.id, displayName: user.displayName },
				helperId: body.helperUserId,
				courseId: body.courseId,
			});
			if (result === "not_allowed") {
				return sendError(
					reply,
					400,
					"VALIDATION_FAILED",
					"That person does not teach that course of yours.",
				);
			}
			if (result === "open") {
				return sendError(
					reply,
					409,
					"LIVE_HELP_OPEN",
					"Live help is already open in this workspace. End it first.",
				);
			}
			return liveHelpStatus(db, scope.workspaceId, user.id, withAudience);
		},
	);

	app.post("/workspaces/:id/live-help/typing", async (request, reply) => {
		const user = requireUser(request);
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		const body = parseOr400(LiveHelpTypingRequest, request.body, reply);
		if (!body) return;
		const open = await setLiveHelpTyping(db, {
			workspaceId: scope.workspaceId,
			actor: `user:${user.id}`,
			typing: body.typing,
		});
		if (!open) return sendError(reply, 404, "NOT_FOUND", "No live help is open.");
		return liveHelpStatus(db, scope.workspaceId, user.id, withAudience);
	});

	// Ending what is already over still answers the status.
	app.post("/workspaces/:id/live-help/stop", async (request, reply) => {
		const user = requireUser(request);
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		await stopLiveHelp(db, {
			workspaceId: scope.workspaceId,
			actor: `user:${user.id}`,
		});
		return liveHelpStatus(db, scope.workspaceId, user.id, withAudience);
	});
}
