import type { WebSocket } from "@fastify/websocket";
import { MAX_EVENT_SOCKETS_PER_WORKSPACE } from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerDeps } from "../server.js";
import { createPendingWork, workspaceUpgradeGuard } from "./presence.js";
import { type ProjectScope, scopedProject } from "./project-scope.js";
import { pipeOneWay } from "./terminal-pipe.js";

/**
 * Event sockets open per workspace, counted here rather than trusted to the
 * agent: the agent port is inside the workspace, where student code runs
 * (SPEC.md §24.1). This is per API process; the pilot runs one (ADR 0010).
 */
const openEventSockets = new Map<string, number>();

/**
 * Take one of the workspace's event socket slots, or false when they are all
 * in use.
 */
function takeEventSocket(workspaceId: string): boolean {
	const open = openEventSockets.get(workspaceId) ?? 0;
	if (open >= MAX_EVENT_SOCKETS_PER_WORKSPACE) return false;
	openEventSockets.set(workspaceId, open + 1);
	return true;
}

/** Give a slot back. */
function releaseEventSocket(workspaceId: string): void {
	const open = (openEventSockets.get(workspaceId) ?? 1) - 1;
	if (open <= 0) openEventSockets.delete(workspaceId);
	else openEventSockets.set(workspaceId, open);
}

/**
 * The reason the browser is given for an agent close. The agent's own bytes
 * are never relayed: only these fixed strings, which the control plane owns
 * (SPEC.md §24.1).
 */
function browserCloseReason(code: number): string {
	if (code === 4404) return "project not found";
	if (code === 1008) return "too many watchers";
	if (code === 1011) return "watcher failed";
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
				socket.close(1011, "watcher failed");
				socket.resume();
				return;
			}
			if (!takeEventSocket(scope.workspaceId)) {
				socket.close(1008, "too many watchers");
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
				}).finally(() => releaseEventSocket(scope.workspaceId)),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}
