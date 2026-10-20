import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import { CloseCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import { pipeBackpressure, safeCloseCode } from "./terminal-pipe.js";

/** How often the pipe re-checks that the browser's session still exists (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 1000;

/** How long the agent socket may take to answer the upgrade. */
const AGENT_HANDSHAKE_TIMEOUT_MS = 5000;

/** Text a browser may send before the agent socket is open. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

export interface MessagePipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	/** The agent socket to relay to, and its authorization header. */
	url: string;
	authHeader: string;
	workspaceId: string;
	sessionToken: string | null;
	log: FastifyBaseLogger;
	/** The largest frame accepted from the agent, which is student-controlled (SPEC.md §24.1). */
	maxAgentFrameBytes: number;
	/** The fixed reason the browser hears when the agent closes. */
	closeReason: (safeCode: number) => string;
	/** What the browser hears when the agent answers the upgrade with a 404. */
	missingRoute: { code: number; reason: string };
	/** The log message for an agent socket error. */
	failureMessage: string;
}

/**
 * Relay text frames both ways between one browser socket and one agent
 * socket, one message per frame. No frame is ever read or changed, and the
 * close reasons the browser hears are fixed strings of ours (SPEC.md §13.6,
 * §24.1). The browser-to-API size limit is the global WebSocket one.
 */
export async function pipeMessages(options: MessagePipeOptions): Promise<void> {
	const { db, socket, workspaceId, sessionToken, log } = options;

	const upstream = new WebSocketClient(options.url, {
		headers: { authorization: options.authHeader },
		handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
		maxPayload: options.maxAgentFrameBytes,
	});

	// Frames can arrive before the agent socket finishes connecting.
	const queued: string[] = [];
	let queuedBytes = 0;
	let closed = false;
	let refused = false;
	// Set once the API ends the browser socket. ws keeps delivering frames
	// for up to 30 seconds while it waits for the peer's close, so nothing
	// after this point may reach the agent (SPEC.md §24.1).
	let inputStopped = false;

	const backpressure = pipeBackpressure(socket, upstream);

	function endBrowser(code: number, reason: string): void {
		inputStopped = true;
		queued.length = 0;
		if (
			upstream.readyState === WebSocketClient.OPEN ||
			upstream.readyState === WebSocketClient.CONNECTING
		) {
			upstream.close(1000, "browser closed");
		}
		socket.close(code, reason);
	}

	// jscpd:ignore-start -- the session check and close handling mirror pipeOneWay in terminal-pipe.ts.
	async function sessionStillValid(): Promise<void> {
		const user = sessionToken ? await loadSession(db, sessionToken) : null;
		if (user && !sessionGate(user)) return;
		if (!inputStopped) endBrowser(CloseCode.SESSION_ENDED, "session revoked");
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

		socket.on("message", (data: RawData, isBinary: boolean) => {
			if (inputStopped) return;
			if (isBinary) {
				endBrowser(1003, "text frames only");
				return;
			}
			const text = data.toString();
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.send(text);
			} else if (upstream.readyState === WebSocketClient.CONNECTING) {
				queuedBytes += Buffer.byteLength(text);
				if (queuedBytes > MAX_QUEUED_BYTES) {
					endBrowser(1009, "too much input before the server was ready");
					return;
				}
				queued.push(text);
			}
		});

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

		upstream.on("open", () => {
			for (const frame of queued.splice(0)) upstream.send(frame);
			queuedBytes = 0;
		});

		upstream.on("message", (data: RawData, isBinary: boolean) => {
			if (socket.readyState !== socket.OPEN || isBinary) return;
			socket.send(data.toString());
			backpressure.apply();
		});

		// An agent from before code help has no route and answers 404; the
		// browser is told the server is unavailable. Handling this event
		// leaves the handshake open, so it is aborted here.
		upstream.on("unexpected-response", (request, response) => {
			refused = true;
			const missing = response.statusCode === 404;
			if (socket.readyState === socket.OPEN) {
				if (missing)
					socket.close(options.missingRoute.code, options.missingRoute.reason);
				else socket.close(CloseCode.SERVER_ERROR, "agent unavailable");
			}
			if (!missing) {
				log.error({ workspaceId, status: response.statusCode }, options.failureMessage);
			}
			request.destroy();
			finish();
		});

		// The agent's reason bytes are never relayed; the browser gets our own
		// words for the close (SPEC.md §24.1).
		upstream.on("close", (code: number) => {
			if (socket.readyState === socket.OPEN) {
				const safe = safeCloseCode(code);
				socket.close(safe, options.closeReason(safe));
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			// A refused upgrade or the browser closing first is the normal path.
			const line = { err: error, workspaceId };
			if (closed || refused || inputStopped) log.info(line, options.failureMessage);
			else log.error(line, options.failureMessage);
			if (socket.readyState === socket.OPEN) {
				socket.close(CloseCode.SERVER_ERROR, "agent unavailable");
			}
			finish();
		});
	});
	// jscpd:ignore-end
}
