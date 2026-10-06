/**
 * One root shell's WebSocket (ADR 0051). Unlike a workspace terminal's it
 * never reconnects: closing the socket ends the shell, so a new connection
 * would be a new shell.
 */
import { CloseCode } from "@portikus/contracts";
import { sessionEnded } from "../../api/sessionEnded.js";
import { wsUrl } from "../../api/ws.js";
import { decodeTerminalFrame } from "../../terminal/terminalFrames.js";

/** The close code a stopping API sends (`pipe.stop` in apps/api). */
const SERVER_STOPPING = 1001;

/** Why a root shell's socket closed without the shell exiting. */
export type RootShellLoss = "too_many" | "server_stopped" | "refused" | "closed";

export interface RootShellSocketEvents {
	onOpen: () => void;
	onOutput: (bytes: Uint8Array) => void;
	/** The first output: the pane should say its size again. */
	onFirstOutput: () => void;
	/** The shell exited. The socket is already stopped. */
	onExit: () => void;
	/** The socket closed and the shell is gone, for `reason`. */
	onLost: (reason: RootShellLoss) => void;
	/** An error frame; the socket stays up. */
	onError: (code: string) => void;
}

export interface RootShellSocket {
	send: (message: unknown) => void;
	/** Close the socket, which hangs up the shell. */
	stop: () => void;
}

export function openRootShellSocket(
	size: { cols: number; rows: number },
	events: RootShellSocketEvents,
): RootShellSocket {
	let stopped = false;
	let outputSeen = false;
	const socket = new WebSocket(
		wsUrl(`/admin/root-shell/ws?cols=${size.cols}&rows=${size.rows}`),
	);
	socket.binaryType = "arraybuffer";

	socket.onopen = () => events.onOpen();

	socket.onmessage = (event: MessageEvent) => {
		const frame = decodeTerminalFrame(event.data);
		if (frame.kind === "output") {
			events.onOutput(frame.bytes);
			if (!outputSeen) {
				outputSeen = true;
				events.onFirstOutput();
			}
			return;
		}
		if (frame.kind === "exit") {
			stopped = true;
			socket.close();
			events.onExit();
			return;
		}
		if (frame.kind === "error") events.onError(frame.code);
	};

	socket.onclose = (event: CloseEvent) => {
		if (stopped) return;
		stopped = true;
		if (event.code === CloseCode.SESSION_ENDED) {
			sessionEnded();
			return;
		}
		if (event.code === CloseCode.TOO_MANY_SOCKETS) {
			events.onLost("too_many");
			return;
		}
		if (event.code === SERVER_STOPPING) {
			events.onLost("server_stopped");
			return;
		}
		// The API closes a shell the host refused just as it closes one that
		// ended; with no output yet, the shell never started.
		events.onLost(outputSeen ? "closed" : "refused");
	};

	return {
		send(message) {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
		},
		stop() {
			stopped = true;
			socket.close();
		},
	};
}
