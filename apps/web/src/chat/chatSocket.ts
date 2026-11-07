/**
 * One chat tab's socket at `/workspaces/:id/terminals/:tid/chat` (SPEC.md
 * §10.8). It reconnects the way a terminal's socket does; each new socket
 * starts with a snapshot, so nothing is replayed by hand.
 */
import { type ChatClientMessage, CloseCode } from "@portikus/contracts";
import { sessionEnded } from "../api/sessionEnded.js";
import { wsUrl } from "../api/ws.js";
import {
	MAX_RECONNECT_ATTEMPTS,
	MAX_RECONNECT_MS,
	RECONNECT_MS,
} from "../terminal/terminalSocket.js";

/** Close codes that retrying will not fix. */
const FATAL_CLOSE_CODES = new Set<number>([
	CloseCode.POLICY,
	1009,
	CloseCode.SERVER_ERROR,
]);

export interface ChatSocketEvents {
	onOpen: () => void;
	onFrame: (data: unknown) => void;
	onReconnecting: () => void;
	/** Retrying stopped for good. */
	onLost: () => void;
	onTooMany: () => void;
	/** The tab is not a chat or no longer exists. */
	onNotFound: () => void;
}

export interface ChatSocket {
	/** False when the socket is not open, so nothing was sent. */
	send: (message: ChatClientMessage) => boolean;
	/** Close the socket and never reconnect. */
	stop: () => void;
}

export function chatSocketPath(workspaceId: string, terminalId: string): string {
	return `/workspaces/${workspaceId}/terminals/${terminalId}/chat`;
}

export function openChatSocket(path: string, events: ChatSocketEvents): ChatSocket {
	let stopped = false;
	let socket: WebSocket | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let backoffMs = RECONNECT_MS;
	let attempts = 0;

	function connect() {
		if (stopped) return;
		const next = new WebSocket(wsUrl(path));
		socket = next;
		next.onopen = () => {
			backoffMs = RECONNECT_MS;
			attempts = 0;
			events.onOpen();
		};
		next.onmessage = (event: MessageEvent) => events.onFrame(event.data);
		next.onclose = (event: CloseEvent) => {
			if (stopped) return;
			if (event.code === CloseCode.SESSION_ENDED) {
				stopped = true;
				sessionEnded();
				return;
			}
			if (event.code === CloseCode.NOT_FOUND) {
				stopped = true;
				events.onNotFound();
				return;
			}
			if (event.code === CloseCode.TOO_MANY_SOCKETS) {
				stopped = true;
				events.onTooMany();
				return;
			}
			attempts++;
			if (FATAL_CLOSE_CODES.has(event.code) || attempts >= MAX_RECONNECT_ATTEMPTS) {
				stopped = true;
				events.onLost();
				return;
			}
			events.onReconnecting();
			const wait = backoffMs;
			backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_MS);
			retry = setTimeout(connect, wait);
		};
	}

	connect();

	return {
		send(message) {
			if (!socket || socket.readyState !== WebSocket.OPEN) return false;
			socket.send(JSON.stringify(message));
			return true;
		},
		stop() {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			socket?.close();
		},
	};
}
