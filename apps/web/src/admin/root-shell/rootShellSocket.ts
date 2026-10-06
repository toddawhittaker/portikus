/**
 * One root shell's WebSocket (ADR 0051). Unlike a workspace terminal's it
 * never reconnects: closing the socket ends the shell, so a new connection
 * would be a new shell.
 */
import { CloseCode, MeResponse } from "@portikus/contracts";
import { sessionEnded } from "../../api/sessionEnded.js";
import { wsUrl } from "../../api/ws.js";
import { decodeTerminalFrame } from "../../terminal/terminalFrames.js";

/** The close code a stopping API sends (`pipe.stop` in apps/api). */
const SERVER_STOPPING = 1001;

/**
 * Why a root shell's socket closed without the shell exiting. `forbidden`
 * means the account is no longer an administrator; `unchecked` means the
 * server could not confirm the session, so it ended the shell to be safe.
 */
export type RootShellLoss =
	| "too_many"
	| "server_stopped"
	| "refused"
	| "forbidden"
	| "unchecked"
	| "closed";

/**
 * Whether this browser's session may still open a root shell. The API
 * refuses a revoked or demoted session at the upgrade with a 401 or 403,
 * which the browser only sees as a closed socket, so ask the session itself.
 * A failed check says nothing either way.
 */
async function rootShellAccess(): Promise<"ended" | "forbidden" | "ok"> {
	try {
		const response = await fetch("/auth/me", { credentials: "same-origin" });
		if (response.status === 401) return "ended";
		if (response.status === 403) return "forbidden";
		if (!response.ok) return "ok";
		const me = MeResponse.pick({ role: true }).safeParse(await response.json());
		if (me.success && me.data.role !== "administrator") return "forbidden";
		return "ok";
	} catch {
		return "ok";
	}
}

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
			// A demotion ends the shell with this code while the session lives
			// on, so only a session the server no longer knows goes to sign-in.
			void rootShellAccess().then((access) => {
				if (access === "ended") sessionEnded();
				else events.onLost(access === "forbidden" ? "forbidden" : "unchecked");
			});
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
		if (outputSeen) {
			// After the shell started, a server error is the session check
			// failing, as when the database is down.
			events.onLost(event.code === CloseCode.SERVER_ERROR ? "unchecked" : "closed");
			return;
		}
		// The API closes a shell the host refused just as it closes one that
		// ended, and refuses a lost session before the socket opens; with no
		// output yet, the shell never started, and the session says why.
		void rootShellAccess().then((access) => {
			if (access === "ended") sessionEnded();
			else events.onLost(access === "forbidden" ? "forbidden" : "refused");
		});
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
