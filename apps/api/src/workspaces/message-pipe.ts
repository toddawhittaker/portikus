import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import { CloseCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import {
	AGENT_HANDSHAKE_TIMEOUT_MS,
	MAX_AGENT_FRAME_BYTES,
	pipeBackpressure,
	SESSION_CHECK_INTERVAL_MS,
	safeCloseCode,
} from "./terminal-pipe.js";

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
	/**
	 * Whether frames the browser sends travel to the agent. When false they are
	 * dropped, so a hostile page cannot reach the agent through this socket
	 * (SPEC.md §24.6).
	 */
	forwardBrowserFrames: boolean;
	/**
	 * The reason the browser hears when the agent closes. It gets the agent's
	 * own reason to compare against a fixed list; it must never return that
	 * text unchecked (SPEC.md §24.1).
	 */
	closeReason: (safeCode: number, agentReason: string) => string;
	/** What the browser hears when the agent answers the upgrade with a 404; none means a plain failure. */
	missingRoute?: { code: number; reason: string };
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
	// The reverse direction: an agent that stops reading must stop the API
	// reading the browser (SPEC.md §24.1).
	const inbound = pipeBackpressure(upstream, socket);

	// The agent is told only that the browser went away, never the browser's
	// own reason bytes (SPEC.md §24.1).
	function closeUpstream(code: number): void {
		const live =
			upstream.readyState === WebSocketClient.OPEN ||
			upstream.readyState === WebSocketClient.CONNECTING;
		if (live) upstream.close(code, "browser closed");
	}

	function sendQueued(): void {
		for (const frame of queued.splice(0)) upstream.send(frame);
		queuedBytes = 0;
	}

	function endBrowser(code: number, reason: string): void {
		inputStopped = true;
		queued.length = 0;
		closeUpstream(1000);
		socket.close(code, reason);
	}

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
			inbound.cancel();
			resolve();
		}

		socket.on("message", (data: RawData, isBinary: boolean) => {
			if (inputStopped || !options.forwardBrowserFrames) return;
			if (isBinary) {
				endBrowser(1003, "text frames only");
				return;
			}
			const text = data.toString();
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.send(text);
				inbound.apply();
			} else if (upstream.readyState === WebSocketClient.CONNECTING) {
				queuedBytes += Buffer.byteLength(text);
				if (queuedBytes > MAX_QUEUED_BYTES) {
					endBrowser(1009, "too much input before the server was ready");
					return;
				}
				queued.push(text);
			}
		});

		socket.on("close", (code: number) => {
			closeUpstream(safeCloseCode(code));
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("open", sendQueued);

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
			const route = response.statusCode === 404 ? options.missingRoute : undefined;
			const missing = route !== undefined;
			if (socket.readyState === socket.OPEN) {
				if (route) socket.close(route.code, route.reason);
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
		upstream.on("close", (code: number, reason: Buffer) => {
			if (socket.readyState === socket.OPEN) {
				const safe = safeCloseCode(code);
				socket.close(safe, options.closeReason(safe, reason.toString()));
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
}

export type OneWayPipeOptions = Omit<
	MessagePipeOptions,
	"forwardBrowserFrames" | "maxAgentFrameBytes" | "missingRoute"
>;

/**
 * Forward frames from one agent socket to one browser socket. Nothing travels
 * the other way: a frame the browser sends is dropped, so a hostile page
 * cannot reach the agent through this socket (SPEC.md §24.6).
 */
export function pipeOneWay(options: OneWayPipeOptions): Promise<void> {
	return pipeMessages({
		...options,
		forwardBrowserFrames: false,
		maxAgentFrameBytes: MAX_AGENT_FRAME_BYTES,
	});
}
