import { connect } from "node:net";
import { type CodingAgent, MAX_CHAT_SERVER_FRAME_BYTES } from "@portikus/contracts";
import { AgentFailure } from "../errors.js";
import { SWITCH_SAME_AGENT_MESSAGE } from "./core.js";
import { chatSocketPath, readLines, writeLine } from "./wire.js";

/** The longest a host may take to read its conversation and prepare a swap. */
const SWITCH_PREPARE_MS = 30_000;

/**
 * Ask a chat tab's running host to prepare a swap to `agent` (SPEC.md
 * §10.8). The host answers on this connection: an `error` frame refuses,
 * as mid-reply; closing the connection without one means the handoff is
 * written and the host may be replaced. The frames are never logged.
 */
export function askHostToSwitch(
	socketDir: string,
	terminalId: string,
	agent: CodingAgent,
	timeoutMs = SWITCH_PREPARE_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(chatSocketPath(socketDir, terminalId));
		let refused = false;
		const fail = (error: AgentFailure) => {
			refused = true;
			socket.destroy();
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new AgentFailure("CHAT_SWITCH_TIMEOUT", "the chat did not answer")),
			timeoutMs,
		);
		socket.on("connect", () => {
			writeLine(socket, JSON.stringify({ type: "agent.switch", agent }));
		});
		socket.on("error", () => {
			clearTimeout(timer);
			if (!refused) fail(new AgentFailure("TERMINAL_NOT_FOUND", "no such chat"));
		});
		readLines(socket, MAX_CHAT_SERVER_FRAME_BYTES, (line) => {
			let frame: { type?: unknown; message?: unknown };
			try {
				frame = JSON.parse(line) as { type?: unknown; message?: unknown };
			} catch {
				return;
			}
			if (frame.type !== "error" || refused) return;
			clearTimeout(timer);
			fail(
				frame.message === SWITCH_SAME_AGENT_MESSAGE
					? new AgentFailure("CHAT_SAME_AGENT", "the chat already runs that agent")
					: new AgentFailure("CHAT_BUSY", "the chat cannot switch agents now"),
			);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (!refused) resolve();
		});
	});
}
