import type { WebSocket } from "@fastify/websocket";
import { CloseCode, MAX_EVENT_SOCKETS_PER_WORKSPACE } from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerDeps } from "../deps.js";
import { createPendingWork, workspaceUpgradeGuard } from "../workspaces/presence.js";
import { type ProjectScope, scopedProject } from "../workspaces/project-scope.js";
import { createSocketSlots } from "../workspaces/socket-slots.js";
import { pipeOneWay } from "../workspaces/terminal-pipe.js";

/** Event sockets open per workspace (SPEC.md §11.4, §24.1). */
const eventSockets = createSocketSlots(MAX_EVENT_SOCKETS_PER_WORKSPACE);

/**
 * The reason the browser is given for an agent close. The agent's own bytes
 * are never relayed: only these fixed strings, which the control plane owns
 * (SPEC.md §24.1).
 */
function browserCloseReason(code: number): string {
	if (code === CloseCode.NOT_FOUND) return "project not found";
	if (code === CloseCode.POLICY) return "too many watchers";
	if (code === CloseCode.SERVER_ERROR) return "watcher failed";
	return "agent closed";
}

declare module "fastify" {
	interface FastifyRequest {
		/** The project the events upgrade guard already loaded and authorized. */
		projectScope?: ProjectScope;
	}
}

/**
 * The browser end of the project events pipe (SPEC.md §11.4, STACK.md §5).
 * One browser socket gets one agent socket, and frames travel one way only:
 * the agent describes filesystem and Git changes, and the browser has nothing
 * to say back.
 */
export function registerProjectEventsSocket(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const { track, drain } = createPendingWork();

	app.get(
		"/workspaces/:id/projects/:pid/events",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				// The one ownership gate for this socket: the same check every
				// other project route makes, answered before the upgrade so a
				// refusal is a plain HTTP status (SPEC.md §5.2, §24.6).
				async (request, reply) => {
					const scope = await scopedProject(db, config, request, reply);
					if (!scope) return reply;
					request.projectScope = scope;
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			// Hold incoming frames until the pipe's listeners are attached.
			socket.pause();
			const scope = request.projectScope;
			if (!scope) {
				// The guard above always sets the scope, so getting here is a
				// bug in this file rather than anything the student did.
				socket.close(CloseCode.SERVER_ERROR, "watcher failed");
				socket.resume();
				return;
			}
			if (!eventSockets.take(scope.workspaceId)) {
				socket.close(CloseCode.POLICY, "too many watchers");
				socket.resume();
				return;
			}
			track(
				pipeOneWay({
					db,
					socket,
					url: scope.agent.projectEventsUrl(scope.slug),
					authHeader: scope.agent.authHeader(),
					workspaceId: scope.workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
					closeReason: browserCloseReason,
					failureMessage: "project events agent socket failed",
				}).finally(() => eventSockets.release(scope.workspaceId)),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}
