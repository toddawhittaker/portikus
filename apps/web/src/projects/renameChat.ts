/**
 * Rename a chat from the left pane (ADR 0074). The rename travels on the
 * chat's own socket, opened for this one message; the new title comes back
 * through the agent status, so the socket closes once the caller sees it.
 */
import { chatSocketPath, openChatSocket } from "../chat/chatSocket.js";

/** How long a rename waits for an error before it counts as done. */
export const RENAME_QUIET_MS = 5000;

const LOST = "The chat could not be reached. Try again.";

export interface ChatRename {
	/** Resolves when the title arrives or the wait passes quietly; rejects with the host's error. */
	done: Promise<void>;
	/** The new title arrived: close the socket. */
	finish: () => void;
}

export function renameChat(
	workspaceId: string,
	terminalId: string,
	title: string,
): ChatRename {
	let settle: (error?: Error) => void = () => undefined;
	const done = new Promise<void>((resolve, reject) => {
		settle = (error) => {
			clearTimeout(quiet);
			socket.stop();
			if (error) reject(error);
			else resolve();
		};
	});
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let sent = false;
	const socket = openChatSocket(chatSocketPath(workspaceId, terminalId), {
		onOpen: () => {
			if (sent) return;
			sent = socket.send({ type: "rename", title });
			quiet = setTimeout(() => settle(), RENAME_QUIET_MS);
		},
		onFrame: (data) => {
			if (!sent || typeof data !== "string") return;
			try {
				const frame = JSON.parse(data) as { type?: unknown; message?: unknown };
				if (frame.type === "error") {
					settle(new Error(typeof frame.message === "string" ? frame.message : LOST));
				}
			} catch {
				// Not ours to read.
			}
		},
		onReconnecting: () => undefined,
		onLost: () => settle(new Error(LOST)),
		onTooMany: () =>
			settle(new Error("Too many open chat views. Close one, then try again.")),
		onNotFound: () => settle(new Error("That chat has ended.")),
	});
	return { done, finish: () => settle() };
}
