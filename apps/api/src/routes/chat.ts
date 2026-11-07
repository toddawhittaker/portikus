import type { WebSocket } from "@fastify/websocket";
import {
	CloseCode,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../deps.js";
import { pipeMessages } from "../workspaces/message-pipe.js";
import {
	createPendingWork,
	dropPresence,
	openPresence,
	PRESENCE_INTERVAL_MS,
	touchPresence,
	workspaceUpgradeGuard,
} from "../workspaces/presence.js";
import { createSocketSlots } from "../workspaces/socket-slots.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";

const TerminalParam = z.object({ id: z.string().uuid(), tid: z.string().uuid() });

/** Browser attachments per chat tab, as for a terminal (SPEC.md §9.7). */
const chatAttachments = createSocketSlots(MAX_ATTACHMENTS_PER_TERMINAL);

/** The browser hears these words, never the agent's own reason bytes (SPEC.md §24.1). */
function browserCloseReason(code: number): string {
	if (code === CloseCode.NOT_FOUND) return "chat not found";
	if (code === 1009) return "frame too large";
	return "chat closed";
}

/**
 * The browser end of the chat relay (SPEC.md §9.7, §24.1). Only the
 * workspace's owner may open it: not an administrator, an instructor, a
 * share viewer or a live-help helper. Frames travel both ways unread,
 * unlogged and unstored (STACK.md §15, ADR 0012).
 */
export function registerChatSocket(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const { track, drain } = createPendingWork();

	app.get(
		"/workspaces/:id/terminals/:tid/chat",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				// A wrong terminal is refused before the upgrade, like the other sockets.
				async (request, reply) => {
					const params = TerminalParam.safeParse(request.params);
					const terminal = params.success
						? await db
								.selectFrom("terminals")
								.select("kind")
								.where("id", "=", params.data.tid)
								.where("workspace_id", "=", params.data.id)
								.where("ended_at", "is", null)
								.executeTakeFirst()
						: undefined;
					if (terminal?.kind !== "chat") {
						return reply
							.status(404)
							.send({ code: "TERMINAL_NOT_FOUND", message: "Terminal not found" });
					}
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			// Hold incoming frames until the pipe's listeners are attached.
			socket.pause();
			const params = TerminalParam.safeParse(request.params);
			const workspace = request.workspaceRow ?? null;
			const agent = workspace ? agentClientFor(workspace, config.AGENT_PORT) : null;
			if (!params.success || !workspace || !agent) {
				socket.close(1011, "agent unavailable");
				socket.resume();
				return;
			}
			const { id: workspaceId, tid: terminalId } = params.data;

			// The guard is owner-only, so the owner is the user on this socket.
			const userId = workspace.owner_user_id;
			if (!terminalSockets.take(userId)) {
				socket.close(CloseCode.TOO_MANY_SOCKETS, "too many connections");
				socket.resume();
				return;
			}
			if (!chatAttachments.take(terminalId)) {
				terminalSockets.release(userId);
				socket.close(CloseCode.TOO_MANY_SOCKETS, "too many connections");
				socket.resume();
				return;
			}
			const release = () => {
				terminalSockets.release(userId);
				chatAttachments.release(terminalId);
			};

			const connectionId = crypto.randomUUID();
			try {
				await openPresence(db, workspaceId, connectionId);
			} catch (error) {
				release();
				throw error;
			}
			const dropOwnPresence = () =>
				dropPresence(db, connectionId).catch((error) => {
					request.log.error(
						{ err: error, connectionId },
						"failed to delete workspace connection",
					);
				});

			if (socket.readyState !== socket.OPEN) {
				// The browser gave up while we were writing presence.
				release();
				track(dropOwnPresence());
				socket.resume();
				return;
			}

			const presenceTimer = setInterval(() => {
				void touchPresence(db, connectionId).catch(() => {});
			}, PRESENCE_INTERVAL_MS);

			track(
				pipeMessages({
					db,
					socket,
					url: agent.chatUrl(terminalId),
					authHeader: agent.authHeader(),
					workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
					maxAgentFrameBytes: MAX_CHAT_SERVER_FRAME_BYTES,
					forwardBrowserFrames: true,
					closeReason: browserCloseReason,
					missingRoute: { code: CloseCode.NOT_FOUND, reason: "chat not found" },
					oversizedFrame: { code: 1009, reason: "frame too large" },
					failureMessage: "chat agent socket failed",
				}).finally(() => {
					clearInterval(presenceTimer);
					release();
					track(dropOwnPresence());
				}),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}
