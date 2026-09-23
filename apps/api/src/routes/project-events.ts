import type { WebSocket } from "@fastify/websocket";
import { loadSession } from "@portikus/auth";
import { MAX_EVENT_SOCKETS_PER_WORKSPACE } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import type { AgentClient } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { createPendingWork, workspaceUpgradeGuard } from "./presence.js";
import { type ProjectScope, scopedProject } from "./project-scope.js";
import { pipeBackpressure, safeCloseCode } from "./terminals.js";

/** How often an open events socket re-checks its session (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 1000;

/** How long the agent socket may take to answer the upgrade. */
const AGENT_HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * The largest frame the control plane accepts from a workspace agent. The
 * agent's own batches are far smaller, so anything past this is a fault or an
 * attempt to make the control plane buffer without limit (SPEC.md §24.1).
 */
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

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
			// A HEAD twin would reach the socket handler and crash (issue #402).
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
				pipeEvents({
					db,
					socket,
					agent: scope.agent,
					slug: scope.slug,
					workspaceId: scope.workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
				}).finally(() => releaseEventSocket(scope.workspaceId)),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}

interface PipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	agent: AgentClient;
	slug: string;
	workspaceId: string;
	log: FastifyBaseLogger;
	sessionToken: string | null;
}

/**
 * Forward event frames from one agent socket to one browser socket. Nothing
 * travels the other way: a frame the browser sends is dropped, so a hostile
 * page cannot reach the agent through this socket (SPEC.md §24.6).
 */
async function pipeEvents(options: PipeOptions): Promise<void> {
	const { db, socket, agent, slug, workspaceId, sessionToken, log } = options;

	const upstream = new WebSocketClient(agent.projectEventsUrl(slug), {
		headers: { authorization: agent.authHeader() },
		handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
		maxPayload: MAX_AGENT_FRAME_BYTES,
	});

	let closed = false;
	const backpressure = pipeBackpressure(socket, upstream);

	async function sessionStillValid(): Promise<void> {
		const user = sessionToken ? await loadSession(db, sessionToken) : null;
		if (user) return;
		socket.close(4401, "session revoked");
	}

	const sessionTimer = setInterval(() => {
		void sessionStillValid().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	await new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve();
		}

		// Nothing the browser sends is forwarded; this socket is one-way.
		socket.on("message", () => {});

		// The browser's own reason bytes are never sent on: the agent is told
		// only that the browser went away (SPEC.md §24.1).
		socket.on("close", (code: number) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), "browser closed");
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("message", (data: RawData) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(data.toString());
			backpressure.apply();
		});

		// The agent's close code says what happened -- 4404 for a project that
		// is gone, 1008 when the agent has all the event sockets it allows --
		// and the browser gets our own words for it (SPEC.md §11.4, §24.1).
		upstream.on("close", (code: number) => {
			if (socket.readyState === socket.OPEN) {
				const safe = safeCloseCode(code);
				socket.close(safe, browserCloseReason(safe));
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			// The slug is a student-chosen name, so it stays out of the log.
			const line = { err: error, workspaceId };
			if (closed) log.info(line, "project events agent socket failed");
			else log.error(line, "project events agent socket failed");
			if (socket.readyState === socket.OPEN) {
				socket.close(1011, "agent unavailable");
			}
			finish();
		});
	});
}
