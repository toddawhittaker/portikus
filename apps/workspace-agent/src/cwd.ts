/**
 * Telling the browser what a terminal's pane is doing (SPEC.md §9.1, §9.3).
 * tmux knows the pane's current path and whether a full-screen program holds
 * the screen, so each attachment polls both in one call and sends a frame
 * only when an answer changes.
 */
import type { WebSocket } from "@fastify/websocket";
import type { TerminalServerMessage } from "@portikus/events";
import { paneState } from "./tmux.js";

/**
 * How often one attachment asks tmux about its pane. The browser decides
 * what the mouse wheel does from the answer, so this has to be quick enough
 * that a wheel turn just after nano starts still moves nano.
 */
const POLL_MS = 500;

/** A short first poll so a reload sees the live pane quickly. */
const FIRST_POLL_MS = 250;

export interface CwdWatch {
	stop: () => void;
}

/**
 * Poll one terminal's pane and send what changed on this socket. Call
 * `stop()` when the attachment closes.
 */
export function watchCwd(
	terminalId: string,
	socket: WebSocket,
	socketName?: string,
): CwdWatch {
	let stopped = false;
	let lastPath: string | null = null;
	let lastAlternate: boolean | null = null;
	let timer: NodeJS.Timeout | undefined;

	function send(message: TerminalServerMessage): void {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	}

	async function poll(): Promise<void> {
		if (stopped) return;
		let state: Awaited<ReturnType<typeof paneState>> | null = null;
		try {
			state = await paneState(terminalId, socketName);
		} catch {
			// The session may have gone away; the attachment closes with it.
		}
		if (stopped) return;
		if (state !== null) {
			if (state.path !== null && state.path !== lastPath) {
				lastPath = state.path;
				send({ type: "cwd", path: state.path });
			}
			if (state.alternate !== lastAlternate) {
				lastAlternate = state.alternate;
				send({ type: "screen", alternate: state.alternate });
			}
		}
		timer = setTimeout(() => void poll(), POLL_MS);
	}

	timer = setTimeout(() => void poll(), FIRST_POLL_MS);

	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}
