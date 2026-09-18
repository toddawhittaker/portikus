import type { WebSocket } from "@fastify/websocket";
import { loadSession } from "@portikus/auth";
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
				socket.close(1011, "agent unavailable");
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
				}),
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

		socket.on("close", (code: number, reason: Buffer) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), reason.toString());
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("message", (data: RawData) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(data.toString());
			backpressure.apply();
		});

		// The agent's close code carries the reason the browser needs: 4404 for
		// a project that is gone, 1008 with EVENT_SOCKET_LIMIT when the agent
		// already has all the event sockets it allows (SPEC.md §11.4).
		upstream.on("close", (code: number, reason: Buffer) => {
			if (socket.readyState === socket.OPEN) {
				socket.close(safeCloseCode(code), reason.toString());
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
