import type { Socket } from "node:net";
import { join } from "node:path";
import { sessionName } from "../tmux.js";

/**
 * Where each chat host listens. The terminals unit owns this directory's
 * parent and keeps it across restarts of either unit, so a host outlives a
 * workspace-agent restart (SPEC.md §9.7, §10.8).
 */
export const CHAT_SOCKET_DIR = "/run/portikus-terminals/chat";

/** The host's socket for one chat tab; the id is checked like a tmux session name. */
export function chatSocketPath(dir: string, terminalId: string): string {
	return join(dir, `${sessionName(terminalId)}.sock`);
}

/** Why `readLines` destroyed a stream. */
export class FrameTooLarge extends Error {}

/**
 * Read newline-separated frames from a stream. The route and the host speak
 * one JSON document per line; JSON.stringify never emits a raw newline, so
 * a line is exactly one frame. A line longer than `maxBytes` destroys the
 * stream with FrameTooLarge.
 */
export function readLines(
	socket: Socket,
	maxBytes: number,
	onLine: (line: string) => void,
): void {
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	socket.on("data", (chunk: Buffer) => {
		let start = 0;
		for (;;) {
			const end = chunk.indexOf(0x0a, start);
			if (end === -1) break;
			const piece = chunk.subarray(start, end);
			pendingBytes += piece.length;
			if (pendingBytes > maxBytes) {
				socket.destroy(new FrameTooLarge());
				return;
			}
			pending.push(piece);
			const line = Buffer.concat(pending).toString("utf8");
			pending = [];
			pendingBytes = 0;
			start = end + 1;
			if (line !== "") onLine(line);
		}
		const rest = chunk.subarray(start);
		pendingBytes += rest.length;
		if (pendingBytes > maxBytes) {
			socket.destroy(new FrameTooLarge());
			return;
		}
		if (rest.length > 0) pending.push(rest);
	});
}

/** Write one frame as a line. */
export function writeLine(socket: Socket, frame: string): void {
	if (!socket.destroyed) socket.write(`${frame}\n`);
}
