import { CloseCode } from "@portikus/contracts";
import { sessionEnded } from "../api/sessionEnded.js";
import { wsUrl } from "../api/ws.js";
import { decodeTerminalFrame, type TerminalGoneReason } from "./terminalFrames.js";

export const RECONNECT_MS = 3_000;
export const MAX_RECONNECT_MS = 60_000;
/** Give up after this many consecutive failed connection attempts. */
export const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * Close codes that will not get better by retrying: a policy refusal, a frame
 * that was too large, and a server error.
 */
const FATAL_CLOSE_CODES = new Set<number>([
	CloseCode.POLICY,
	1009,
	CloseCode.SERVER_ERROR,
]);

type TerminalGoneFrame = { reason: TerminalGoneReason; at?: string };

/** What the pane does with each event on its terminal socket (SPEC.md §9.7). */
export interface TerminalSocketEvents {
	/** The size to put in the connect URL, read at each attempt. */
	size: () => { cols: number; rows: number };
	onOpen: () => void;
	/** The socket closed, for whatever reason. */
	onClose: () => void;
	/** A retry is scheduled. */
	onReconnecting: () => void;
	/** Retrying stopped for good. */
	onLost: () => void;
	/** The user has too many terminal sockets open; nothing was retried (SPEC.md §24.13). */
	onTooMany: () => void;
	onOutput: (bytes: Uint8Array) => void;
	/** The first output on this socket: the pane should say its size again. */
	onFirstOutput: () => void;
	/** The shell exited. The socket is already stopped. */
	onExit: () => void;
	/** The session went with a terminals restart. The socket is already stopped. */
	onGone: (frame: TerminalGoneFrame) => void;
	/** An error frame with no reason; the socket stays up. */
	onError: (code: string) => void;
	onCwd: (path: string) => void;
	onScreen: (alternate: boolean) => void;
	onClear: () => void;
	onAgent: (build: string) => void;
}

export interface TerminalSocket {
	send: (message: unknown) => void;
	/** Close the socket and never reconnect. */
	stop: () => void;
}

/**
 * Connects one terminal's socket and reconnects it with a doubling backoff,
 * up to five attempts in a row. A 4401 close hands over to `sessionEnded()`.
 */
export function openTerminalSocket(
	workspaceId: string,
	terminalId: string,
	events: TerminalSocketEvents,
): TerminalSocket {
	let stopped = false;
	let socket: WebSocket | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let backoffMs = RECONNECT_MS;
	let attempts = 0;

	function giveUp() {
		stopped = true;
		events.onLost();
	}

	function connect() {
		if (stopped) return;
		let outputSeen = false;
		const { cols, rows } = events.size();
		const next = new WebSocket(
			wsUrl(
				`/workspaces/${workspaceId}/terminals/${terminalId}/ws?cols=${cols}&rows=${rows}`,
			),
		);
		next.binaryType = "arraybuffer";
		socket = next;

		next.onopen = () => {
			backoffMs = RECONNECT_MS;
			attempts = 0;
			events.onOpen();
		};

		next.onmessage = (event: MessageEvent) => {
			const frame = decodeTerminalFrame(event.data);
			switch (frame.kind) {
				case "output":
					events.onOutput(frame.bytes);
					if (!outputSeen) {
						outputSeen = true;
						events.onFirstOutput();
					}
					return;
				case "exit":
					stopped = true;
					events.onExit();
					next.close();
					return;
				case "error":
					if (!frame.reason) {
						events.onError(frame.code);
						return;
					}
					stopped = true;
					events.onGone({ reason: frame.reason, at: frame.at });
					next.close();
					return;
				case "cwd":
					events.onCwd(frame.path);
					return;
				case "screen":
					events.onScreen(frame.alternate);
					return;
				case "clear":
					events.onClear();
					return;
				case "agent":
					events.onAgent(frame.build);
					return;
			}
		};

		next.onclose = (event: CloseEvent) => {
			events.onClose();
			if (stopped) return;
			if (event.code === CloseCode.SESSION_ENDED) {
				stopped = true;
				sessionEnded();
				return;
			}
			if (event.code === CloseCode.TOO_MANY_SOCKETS) {
				// Retrying would only be refused again until another socket closes.
				stopped = true;
				events.onTooMany();
				return;
			}
			if (FATAL_CLOSE_CODES.has(event.code)) {
				giveUp();
				return;
			}
			attempts++;
			if (attempts >= MAX_RECONNECT_ATTEMPTS) {
				giveUp();
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
			if (socket && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		},
		stop() {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			socket?.close();
		},
	};
}
