import type { WebSocket } from "@fastify/websocket";
import {
	CloseCode,
	CODE_HELP_LANGUAGE_OF_SERVER,
	type CodeHelpLanguage,
	LANGUAGE_SERVER_CLOSE_REASONS,
	LANGUAGE_SERVER_MAX_FRAME_BYTES,
	LanguageServerId,
	MAX_LANGUAGE_SERVER_SOCKETS,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerDeps } from "../deps.js";
import { parseOr400 } from "../http.js";
import { siteSwitches } from "../site/switches.js";
import { pipeMessages } from "../workspaces/message-pipe.js";
import { createPendingWork, workspaceUpgradeGuard } from "../workspaces/presence.js";
import { scopedProject } from "../workspaces/project-scope.js";
import { createSocketSlots } from "../workspaces/socket-slots.js";

/** Language-server sockets open per workspace (SPEC.md §13.6, §24.1). */
const languageServerSockets = createSocketSlots(MAX_LANGUAGE_SERVER_SOCKETS);

/**
 * The browser sockets this process holds open, by code help language, so an
 * administrator turning a language off can end them (SPEC.md §13.6). Like the
 * slot counts above, per API process.
 */
const openByLanguage = new Map<CodeHelpLanguage, Set<WebSocket>>();

function trackOpen(language: CodeHelpLanguage, socket: WebSocket): () => void {
	const sockets = openByLanguage.get(language) ?? new Set<WebSocket>();
	sockets.add(socket);
	openByLanguage.set(language, sockets);
	return () => {
		sockets.delete(socket);
		if (sockets.size === 0 && openByLanguage.get(language) === sockets) {
			openByLanguage.delete(language);
		}
	};
}

/**
 * End every open language-server socket of the given languages, as the check
 * at open time does. A socket's slot goes back through its normal close path.
 */
export function closeLanguageServerSockets(
	languages: readonly CodeHelpLanguage[],
): void {
	for (const language of languages) {
		for (const socket of openByLanguage.get(language) ?? []) {
			if (socket.readyState === socket.OPEN) {
				socket.close(CloseCode.LANGUAGE_SERVER_DISABLED, "code help is off");
			}
		}
	}
}

/** The agent reasons that may pass through: exactly the contract's fixed list. */
const RELAYED_REASONS: ReadonlySet<string> = new Set(
	Object.values(LANGUAGE_SERVER_CLOSE_REASONS),
);

/**
 * The reason the browser is given for an agent close. The agent's own bytes
 * are never relayed, except a reason that exactly equals one on the
 * contract's fixed list; everything else is a string the control plane owns
 * (SPEC.md §24.1).
 */
function browserCloseReason(code: number, agentReason: string): string {
	if (RELAYED_REASONS.has(agentReason)) return agentReason;
	if (code === CloseCode.LANGUAGE_SERVER_REPLACED) return "replaced by another window";
	if (code === CloseCode.LANGUAGE_SERVER_IDLE) return "idle";
	if (code === CloseCode.LANGUAGE_SERVER_CRASHED) return "crashed";
	if (code === CloseCode.LANGUAGE_SERVER_UNAVAILABLE) return "unavailable";
	if (code === CloseCode.LANGUAGE_SERVER_DISABLED) return "code help is off";
	return "agent closed";
}

/**
 * The browser end of the language-server relay (SPEC.md §13.6). Only the
 * workspace's owner may open it: not an administrator, an instructor, a share
 * viewer or a live-help helper. The API carries LSP frames between the
 * browser and the agent without reading them.
 */
export function registerLanguageServerSocket(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const { track, drain } = createPendingWork();

	app.get(
		"/workspaces/:id/projects/:pid/language-servers/:server",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				async (request, reply) => {
					if (
						parseOr400(
							LanguageServerId,
							(request.params as { server?: unknown }).server,
							reply,
							"Unknown language server.",
						) === null
					)
						return reply;
				},
				// The one ownership gate for this socket, answered before the
				// upgrade so a refusal is a plain HTTP status (SPEC.md §5.2, §24.6).
				// `projectScope` is declared with the events socket.
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
			const server = LanguageServerId.safeParse(
				(request.params as { server?: unknown }).server,
			);
			if (!scope || !server.success) {
				// The preHandlers above always set both, so getting here is a
				// bug in this file rather than anything the student did.
				socket.close(CloseCode.SERVER_ERROR, "language server failed");
				socket.resume();
				return;
			}
			// Taken before the first await, so a burst of upgrades cannot slip past the cap.
			if (!languageServerSockets.take(scope.workspaceId)) {
				socket.close(CloseCode.TOO_MANY_SOCKETS, "too many connections");
				socket.resume();
				return;
			}
			// Listed before the switch is read: a write that commits after the
			// read then finds this socket, and one that committed before is seen by it.
			const language = CODE_HELP_LANGUAGE_OF_SERVER[server.data];
			const untrack = trackOpen(language, socket);
			const release = () => {
				untrack();
				languageServerSockets.release(scope.workspaceId);
			};

			let enabled: boolean;
			try {
				const switches = siteSwitches(db);
				track(switches);
				enabled = (await switches).codeHelpLanguages.includes(language);
			} catch (error) {
				request.log.error({ err: error }, "code help languages could not be read");
				release();
				socket.close(CloseCode.SERVER_ERROR, "language server failed");
				socket.resume();
				return;
			}
			if (!enabled || socket.readyState !== socket.OPEN) {
				release();
				// A browser that left while the switch was read has nobody to tell.
				if (socket.readyState === socket.OPEN) {
					socket.close(CloseCode.LANGUAGE_SERVER_DISABLED, "code help is off");
				}
				socket.resume();
				return;
			}

			track(
				pipeMessages({
					db,
					socket,
					url: scope.agent.languageServerUrl(scope.slug, server.data),
					authHeader: scope.agent.authHeader(),
					workspaceId: scope.workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
					maxAgentFrameBytes: LANGUAGE_SERVER_MAX_FRAME_BYTES,
					forwardBrowserFrames: true,
					closeReason: browserCloseReason,
					missingRoute: {
						code: CloseCode.LANGUAGE_SERVER_UNAVAILABLE,
						reason: "unavailable",
					},
					failureMessage: "language server agent socket failed",
				}).finally(release),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}
