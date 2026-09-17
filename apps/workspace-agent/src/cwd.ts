/**
 * Telling the browser which directory a terminal is in (SPEC.md §9.3). tmux
 * knows the pane's current path, so each attachment polls it and sends a
 * `cwd` frame only when the answer changes.
 */
import type { WebSocket } from "@fastify/websocket";
import type { TerminalServerMessage } from "@portikus/events";
import { panePath } from "./tmux.js";

/** How often one attachment asks tmux where its pane is. */
const POLL_MS = 2_000;

/** A short first poll so a reload shows the live directory quickly. */
const FIRST_POLL_MS = 250;

export interface CwdWatch {
	stop: () => void;
}

/**
 * Poll one terminal's pane path and send it on this socket when it changes.
 * Call `stop()` when the attachment closes.
 */
export function watchCwd(
	terminalId: string,
	socket: WebSocket,
	socketName?: string,
): CwdWatch {
	let stopped = false;
	let last: string | null = null;
	let timer: NodeJS.Timeout | undefined;

	async function poll(): Promise<void> {
		if (stopped) return;
		let path: string | null = null;
		try {
			path = await panePath(terminalId, socketName);
		} catch {
			// The session may have gone away; the attachment closes with it.
		}
		if (stopped) return;
		if (path !== null && path !== last) {
			last = path;
			const message: TerminalServerMessage = { type: "cwd", path };
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
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
