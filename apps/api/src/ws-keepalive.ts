import type { WebSocket } from "ws";

/** Well under the 100 seconds a proxy such as Cloudflare lets a socket sit idle. */
export const PING_INTERVAL_MS = 30_000;

/**
 * Pings one browser socket on a timer and ends it after two pings in a row
 * go unanswered, so the browser's own reconnect takes over (SPEC.md §9.2).
 */
export function keepAlive(socket: WebSocket, intervalMs = PING_INTERVAL_MS): void {
	let missed = 0;
	socket.on("pong", () => {
		missed = 0;
	});
	const timer = setInterval(() => {
		if (missed >= 2) {
			socket.terminate();
			return;
		}
		missed += 1;
		socket.ping();
	}, intervalMs);
	timer.unref();
	socket.once("close", () => clearInterval(timer));
}
