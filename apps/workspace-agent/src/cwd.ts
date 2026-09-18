/**
 * Telling the browser what each terminal's pane is doing (SPEC.md §9.7,
 * §9.3). tmux knows every pane's current path and whether a full-screen
 * program holds its screen, and it will list them all in one call, so the
 * agent runs one poll for the whole workspace and sends a frame to a
 * terminal's attachments when its answer changes.
 *
 * One poll for the agent rather than one per attachment: eight terminals with
 * four browsers each would otherwise be sixty-four tmux processes a second
 * for answers that are mostly the same.
 */
import type { WebSocket } from "@fastify/websocket";
import type { TerminalServerMessage } from "@portikus/events";
import { listPanes, type PaneState } from "./tmux.js";

/**
 * How often the panes are polled while one of them has a full-screen program
 * on it. The browser decides what the mouse wheel does from the answer, so
 * leaving and entering such a program should both be noticed quickly.
 */
const BUSY_POLL_MS = 250;

/** And how often otherwise, when only the working directory can change. */
const IDLE_POLL_MS = 500;

/** A short first poll so a reload sees the live pane quickly. */
const FIRST_POLL_MS = 250;

interface Watched {
	sockets: Set<WebSocket>;
	last: PaneState | null;
}

export interface PaneWatcher {
	/** Start sending this socket pane frames, current values first. */
	add: (terminalId: string, socket: WebSocket) => void;
	/** Stop sending this socket pane frames. */
	remove: (terminalId: string, socket: WebSocket) => void;
	/** How many sockets are being fed for one terminal. */
	size: (terminalId: string) => number;
	/** Forget a terminal and everything attached to it. */
	drop: (terminalId: string) => void;
	stop: () => void;
}

function send(socket: WebSocket, message: TerminalServerMessage): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/** One poll for the whole agent, shared by every attachment it serves. */
export function watchPanes(socketName?: string): PaneWatcher {
	const watched = new Map<string, Watched>();
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;

	function schedule(delay: number): void {
		if (stopped) return;
		timer = setTimeout(() => void poll(), delay);
	}

	/** Start polling when the first socket arrives, stop when the last leaves. */
	function ensureRunning(): void {
		if (stopped || timer !== undefined) return;
		schedule(FIRST_POLL_MS);
	}

	function stopIfIdle(): void {
		if (watched.size > 0) return;
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	async function poll(): Promise<void> {
		timer = undefined;
		if (stopped || watched.size === 0) return;
		let panes: Map<string, PaneState>;
		try {
			panes = await listPanes(socketName);
		} catch {
			// No tmux server, or it went away; the attachments close with it.
			schedule(IDLE_POLL_MS);
			return;
		}
		if (stopped) return;

		let anyAlternate = false;
		for (const [terminalId, entry] of watched) {
			const state = panes.get(terminalId);
			if (!state) continue;
			if (state.alternate) anyAlternate = true;
			const last = entry.last;
			if (state.path !== null && state.path !== last?.path) {
				for (const socket of entry.sockets) {
					send(socket, { type: "cwd", path: state.path });
				}
			}
			if (last === null || state.alternate !== last.alternate) {
				for (const socket of entry.sockets) {
					send(socket, { type: "screen", alternate: state.alternate });
				}
			}
			entry.last = state;
		}

		schedule(anyAlternate ? BUSY_POLL_MS : IDLE_POLL_MS);
	}

	return {
		add: (terminalId, socket) => {
			const entry = watched.get(terminalId) ?? { sockets: new Set(), last: null };
			entry.sockets.add(socket);
			watched.set(terminalId, entry);
			// A browser that arrives between polls should not have to wait for
			// the next one to learn where it is.
			if (entry.last?.path != null) {
				send(socket, { type: "cwd", path: entry.last.path });
			}
			if (entry.last) send(socket, { type: "screen", alternate: entry.last.alternate });
			ensureRunning();
		},
		remove: (terminalId, socket) => {
			const entry = watched.get(terminalId);
			if (!entry) return;
			entry.sockets.delete(socket);
			if (entry.sockets.size === 0) watched.delete(terminalId);
			stopIfIdle();
		},
		size: (terminalId) => watched.get(terminalId)?.sockets.size ?? 0,
		drop: (terminalId) => {
			watched.delete(terminalId);
			stopIfIdle();
		},
		stop: () => {
			stopped = true;
			watched.clear();
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
