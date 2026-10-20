import type { WebSocket } from "@fastify/websocket";
import { requireUser } from "@portikus/auth";
import {
	CloseCode,
	type CourseLiveHelpDetail,
	type CourseLiveHelpResponse,
	type CourseLiveHelpSession,
	type TerminalAttachMode,
	TerminalSizeQuery,
	WorkspaceState,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { taughtCourseId } from "../courses/membership.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import {
	helperSocketRefusal,
	type LiveHelpScope,
	liveHelpScope,
} from "../live-help/gate.js";
import { liveHelpSockets } from "../live-help/registry.js";
import { leaveLiveHelp, whereOpen } from "../live-help/sessions.js";
import type { BridgeForwards } from "../preview/bridge.js";
import { createPendingWork } from "../workspaces/presence.js";
import { pipeTerminal } from "../workspaces/terminal-pipe.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";
import { countActive } from "../workspaces/workspace-view.js";

const TerminalParam = z.object({ tid: z.string().uuid() });

declare module "fastify" {
	interface FastifyRequest {
		/** The live help session the socket's gate let through. */
		liveHelpScope?: LiveHelpScope;
	}
}

function sessionView(
	scope: LiveHelpScope,
	student: { displayName: string },
): CourseLiveHelpSession {
	return {
		id: scope.sessionId,
		projectId: scope.projectId,
		projectName: scope.projectName,
		userId: scope.ownerId,
		displayName: student.displayName,
		typing: scope.typing,
		startedAt: scope.startedAt.toISOString(),
		endsAt: scope.endsAt.toISOString(),
		workspaceState: WorkspaceState.parse(scope.workspace.state),
	};
}

/**
 * An instructor's side of live help (ADR 0063): the sessions students opened
 * with them, one session's terminals, leaving, and the terminal socket.
 * Every route goes through `liveHelpScope`, and every answer is `no-store`.
 */
export function registerCourseLiveHelpRoutes(
	app: FastifyInstance,
	deps: ServerDeps & { bridge: BridgeForwards },
): void {
	const { db, config, bridge } = deps;
	const { track, drain } = createPendingWork();

	app.register(async (instance) => {
		// Synchronous, like every onSend hook here: see registerRequestLogging.
		instance.addHook("onSend", (_request, reply, payload, done) => {
			reply.header("cache-control", "no-store");
			done(null, payload);
		});

		instance.get("/courses/:courseId/live-help", async (request, reply) => {
			const helper = requireUser(request);
			const courseId = await taughtCourseId(db, request);
			if (!courseId) return sendError(reply, 404, "NOT_FOUND", "Not found.");
			const rows = await db
				.selectFrom("live_help_sessions")
				.innerJoin("projects", "projects.id", "live_help_sessions.project_id")
				.innerJoin("workspaces", "workspaces.id", "live_help_sessions.workspace_id")
				.innerJoin("users", "users.id", "workspaces.owner_user_id")
				.innerJoin("lti_memberships", (join) =>
					join
						.onRef("lti_memberships.user_id", "=", "users.id")
						.onRef("lti_memberships.context_id", "=", "live_help_sessions.course_id"),
				)
				.select([
					"live_help_sessions.id",
					"live_help_sessions.typing",
					"live_help_sessions.started_at",
					"live_help_sessions.ends_at",
					"projects.id as project_id",
					"projects.name",
					"users.id as user_id",
					"users.display_name",
					"workspaces.state",
				])
				.where("live_help_sessions.course_id", "=", courseId)
				.where("live_help_sessions.helper_user_id", "=", helper.id)
				.where(whereOpen)
				.where("projects.state", "=", "active")
				.orderBy("live_help_sessions.started_at")
				.execute();
			const body: CourseLiveHelpResponse = {
				sessions: rows.map((row) => ({
					id: row.id,
					projectId: row.project_id,
					projectName: row.name,
					userId: row.user_id,
					displayName: row.display_name,
					typing: row.typing,
					startedAt: new Date(row.started_at).toISOString(),
					endsAt: new Date(row.ends_at).toISOString(),
					workspaceState: WorkspaceState.parse(row.state),
				})),
			};
			return body;
		});

		instance.get("/courses/:courseId/live-help/:sid", async (request, reply) => {
			const scope = await liveHelpScope(
				db,
				config,
				request,
				reply,
				{ live: false },
				bridge,
			);
			if (!scope) return;
			const student = await db
				.selectFrom("users")
				.select("display_name")
				.where("id", "=", scope.ownerId)
				.executeTakeFirstOrThrow();
			const terminals = await db
				.selectFrom("terminals")
				.select(["id", "name"])
				.where("workspace_id", "=", scope.workspaceId)
				.where("project_id", "=", scope.projectId)
				.where("ended_at", "is", null)
				.orderBy("position")
				.orderBy("created_at")
				.execute();
			const running = scope.workspace.state === "running";
			const body: CourseLiveHelpDetail = {
				session: sessionView(scope, { displayName: student.display_name }),
				studentConnected:
					running && (await countActive(db, scope.workspaceId, config)) > 0,
				terminals: terminals.map((row) => ({ id: row.id, name: row.name })),
			};
			return body;
		});

		instance.post("/courses/:courseId/live-help/:sid/leave", async (request, reply) => {
			const scope = await liveHelpScope(
				db,
				config,
				request,
				reply,
				{ live: false },
				bridge,
			);
			if (!scope) return;
			await leaveLiveHelp(
				db,
				{ sessionId: scope.sessionId, helperId: scope.helperId },
				bridge,
			);
			return reply.status(204).send();
		});

		instance.get(
			"/courses/:courseId/live-help/:sid/terminals/:tid/ws",
			{
				websocket: true,
				// A HEAD twin would reach the socket handler and crash.
				exposeHeadRoute: false,
				preHandler: async (request, reply) => {
					const scope = await liveHelpScope(
						db,
						config,
						request,
						reply,
						{
							live: true,
						},
						bridge,
					);
					if (!scope) return;
					// Only a live terminal of the session's own project.
					const params = TerminalParam.safeParse(request.params);
					const terminal = params.success
						? await db
								.selectFrom("terminals")
								.select("id")
								.where("id", "=", params.data.tid)
								.where("workspace_id", "=", scope.workspaceId)
								.where("project_id", "=", scope.projectId)
								.where("ended_at", "is", null)
								.executeTakeFirst()
						: undefined;
					if (!terminal) return sendError(reply, 404, "NOT_FOUND", "Not found.");
					request.liveHelpScope = scope;
				},
			},
			async (socket: WebSocket, request: FastifyRequest) => {
				// Hold incoming frames until the pipe's listeners are attached.
				socket.pause();
				const scope = request.liveHelpScope;
				const terminalId = (request.params as { tid: string }).tid;
				if (!scope?.agent) {
					socket.close(CloseCode.SERVER_ERROR, "agent unavailable");
					socket.resume();
					return;
				}
				const agent = scope.agent;
				// A helper's sockets count against the helper's own limit (SPEC.md §24.13).
				if (!terminalSockets.take(scope.helperId)) {
					socket.close(CloseCode.TOO_MANY_SOCKETS, "too many terminal connections");
					socket.resume();
					return;
				}
				const mode: TerminalAttachMode = scope.typing ? "type" : "view";
				// Registered before any await, so an end or a mode change from now
				// on reaches this socket, and an older socket on this terminal
				// stops reading input before this one's pipe opens (ADR 0063).
				let endPipe: ((code: number, reason: string) => void) | null = null;
				const unregister = liveHelpSockets.add(
					scope.sessionId,
					terminalId,
					(code, reason) => {
						if (endPipe) return endPipe(code, reason);
						socket.close(code, reason);
						// A paused socket never reads the browser's close reply.
						socket.resume();
					},
				);
				const release = () => {
					unregister();
					terminalSockets.release(scope.helperId);
				};
				try {
					// Written before the pipe opens: no attach goes unrecorded (ADR 0063).
					await recordAudit(db, {
						actor: `user:${scope.helperId}`,
						target: scope.projectId,
						action: "project.live_help_terminal_opened",
						result: "ok",
						metadata: { sessionId: scope.sessionId, terminalId, mode },
					});
				} catch (error) {
					release();
					request.log.error(
						{ err: error, sessionId: scope.sessionId },
						"live help audit failed",
					);
					socket.close(CloseCode.SERVER_ERROR, "could not record the attach");
					socket.resume();
					return;
				}
				// The session may have ended or changed mode while the audit ran.
				const refused =
					socket.readyState === socket.OPEN
						? await helperSocketRefusal(db, config, scope, mode, bridge)
						: null;
				if (socket.readyState !== socket.OPEN || refused) {
					release();
					if (refused) socket.close(refused.code, refused.reason);
					socket.resume();
					return;
				}
				const size = TerminalSizeQuery.parse(request.query ?? {});
				track(
					pipeTerminal({
						db,
						socket,
						agent,
						workspaceId: scope.workspaceId,
						terminalId,
						connectionId: crypto.randomUUID(),
						log: request.log,
						sessionToken: request.sessionToken,
						cols: size.cols,
						rows: size.rows,
						mode,
						presence: false,
						stillAllowed: () => helperSocketRefusal(db, config, scope, mode, bridge),
						register: (end) => {
							endPipe = end;
							return () => {
								endPipe = null;
							};
						},
					}).finally(release),
				);
				socket.resume();
			},
		);
	});

	app.addHook("onClose", drain);
}
