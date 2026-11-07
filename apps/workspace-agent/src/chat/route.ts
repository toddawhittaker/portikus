import { lstat } from "node:fs/promises";
import { connect } from "node:net";
import type { WebSocket } from "@fastify/websocket";
import {
	ChatClientMessage,
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
	TerminalId,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { DRAIN_POLL_MS, HIGH_WATER_BYTES, LOW_WATER_BYTES } from "../terminals.js";
import { chatSocketPath, FrameTooLarge, readLines, writeLine } from "./wire.js";

/** Close code for a chat with no host behind it, as the API's relay uses. */
const CHAT_NOT_FOUND = 4404;

export interface ChatRouteOptions {
	/** Where the chat hosts listen; CHAT_SOCKET_DIR in a workspace. */
	socketDir: string;
}

/**
 * `GET /terminals/:terminalId/chat`: one browser attachment, relayed frame
 * for frame to the chat host's Unix socket (SPEC.md §10.8). Closing it
 * never stops the host, so the next attach after an agent restart simply
 * connects again. Frames are checked for size and shape, never logged.
 */
export async function chatRoute(
	instance: FastifyInstance,
	options: ChatRouteOptions,
): Promise<void> {
	instance.get(
		"/terminals/:terminalId/chat",
		{
			websocket: true,
			// Only a running chat host has a socket, so an unknown terminal and
			// an ordinary one are both refused before the upgrade.
			preValidation: async (request, reply) => {
				const id = TerminalId.safeParse(
					(request.params as { terminalId?: unknown }).terminalId,
				);
				const info = id.success
					? await lstat(chatSocketPath(options.socketDir, id.data)).catch(() => null)
					: null;
				if (!info?.isSocket()) {
					return reply
						.code(404)
						.send({ error: { code: "TERMINAL_NOT_FOUND", message: "no such chat" } });
				}
			},
		},
		(socket: WebSocket, request) => {
			const id = TerminalId.parse(
				(request.params as { terminalId?: unknown }).terminalId,
			);
			relay(socket, chatSocketPath(options.socketDir, id));
			request.log.debug({ terminalId: id }, "chat attached");
		},
	);
}

function relay(socket: WebSocket, path: string): void {
	// Hold the browser's frames until the host is connected.
	socket.pause();
	const host = connect(path);
	let connected = false;
	let drain: NodeJS.Timeout | null = null;

	const close = (code: number, reason: string) => {
		if (drain) clearInterval(drain);
		drain = null;
		host.destroy();
		// A paused socket would never read the browser's closing handshake.
		socket.resume();
		if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
			socket.close(code, reason);
		}
	};

	host.on("connect", () => {
		connected = true;
		socket.resume();
	});
	host.on("error", (error) => {
		if (error instanceof FrameTooLarge) close(1009, "frame too large");
		else if (!connected) close(CHAT_NOT_FOUND, "chat is not running");
		else close(1011, "chat host failed");
	});
	host.on("close", () => close(1000, "chat closed"));

	readLines(host, MAX_CHAT_SERVER_FRAME_BYTES, (line) => {
		socket.send(line);
		// A slow browser must not make the agent hold a host's whole output.
		if (drain || socket.bufferedAmount <= HIGH_WATER_BYTES) return;
		host.pause();
		drain = setInterval(() => {
			if (socket.bufferedAmount >= LOW_WATER_BYTES) return;
			if (drain) clearInterval(drain);
			drain = null;
			host.resume();
		}, DRAIN_POLL_MS);
	});

	socket.on("message", (raw: Buffer, isBinary: boolean) => {
		if (isBinary) return close(1003, "text frames only");
		if (raw.byteLength > MAX_CHAT_CLIENT_FRAME_BYTES)
			return close(1009, "frame too large");
		let parsed: ChatClientMessage;
		try {
			const result = ChatClientMessage.safeParse(JSON.parse(raw.toString("utf8")));
			if (!result.success) return close(1008, "malformed frame");
			parsed = result.data;
		} catch {
			return close(1008, "malformed frame");
		}
		writeLine(host, JSON.stringify(parsed));
	});
	socket.on("close", () => {
		if (drain) clearInterval(drain);
		drain = null;
		host.end();
	});
}
