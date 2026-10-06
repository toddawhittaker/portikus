import type { Socket } from "node:net";
import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import {
	CloseCode,
	MAX_INPUT_FRAME_BYTES,
	type RootShellCloseReason,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { TerminalClientMessage, type TerminalServerMessage } from "@portikus/events";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type { RawData } from "ws";
import { pipeBackpressure } from "../workspaces/terminal-pipe.js";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType } from "./frames.js";

/** How often an open root shell re-checks its session (ADR 0051, SPEC.md §5.3). */
export const SESSION_CHECK_INTERVAL_MS = 1000;

/**
 * Consecutive failed re-checks, about a minute's worth, after which a shell
 * ends because its session can no longer be confirmed (ADR 0051).
 */
export const MAX_FAILED_CHECKS = 60;

/** How long the helper gets to close its end after the API closes its own. */
const HELPER_CLOSE_TIMEOUT_MS = 5000;

/** A helper error code is a fixed word; anything else stays out of the log. */
const HELPER_CODE = /^[a-z_]{1,64}$/;

export interface RootShellPipeOptions {
	db: Kysely<Database>;
	/** The browser socket. */
	socket: WebSocket;
	/** A connected socket to the root-shell helper; the `open` frame is already sent. */
	helper: Socket;
	sessionToken: string | null;
	shellId: string;
	log: FastifyBaseLogger;
}

export interface RootShellPipe {
	/** Resolves with why the shell ended once both sockets are done. */
	done: Promise<RootShellCloseReason>;
	/** End the shell because the API is stopping. */
	stop: () => void;
}

/** A session may keep a root shell only while it is a live administrator's (ADR 0051). */
export async function rootShellSessionValid(
	db: Kysely<Database>,
	sessionToken: string | null,
): Promise<boolean> {
	const user = sessionToken ? await loadSession(db, sessionToken) : null;
	return user !== null && !sessionGate(user) && user.role === "administrator";
}

function sendJson(socket: WebSocket, message: TerminalServerMessage): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Carry one browser terminal socket to one helper connection, translating the
 * browser frames of SPEC.md §9.7 to the helper frames of ADR 0051.
 */
export function pipeRootShell(options: RootShellPipeOptions): RootShellPipe {
	const { db, socket, helper, sessionToken, shellId, log } = options;

	let reason: RootShellCloseReason | null = null;
	// Set once the shell is ending: ws keeps delivering browser frames until
	// the close handshake finishes, and none may reach a root shell (SPEC.md §24).
	let inputStopped = false;
	let lastSessionCheck = Date.now();
	let failedChecks = 0;
	const decoder = new FrameDecoder();
	const backpressure = pipeBackpressure(socket, helper);

	function endWith(why: RootShellCloseReason): void {
		if (reason === null) reason = why;
		inputStopped = true;
	}

	function closeHelper(): void {
		if (helper.destroyed) return;
		helper.end();
		// A helper that never finishes closing must not hold the pipe open.
		setTimeout(() => helper.destroy(), HELPER_CLOSE_TIMEOUT_MS).unref();
	}

	/**
	 * Revocation: the helper is told to end the shell's whole sign-in session,
	 * and the browser hears the session-ended code (ADR 0051). close(), not
	 * terminate(), so the web client still hears the code; input is already off.
	 */
	function revoke(): void {
		if (inputStopped) return;
		endWith("session_ended");
		if (!helper.destroyed) {
			helper.write(encodeJsonFrame(FrameType.END, { reason: "session_ended" }));
		}
		closeHelper();
		socket.close(CloseCode.SESSION_ENDED, "session revoked");
	}

	async function checkSession(): Promise<void> {
		lastSessionCheck = Date.now();
		let valid: boolean;
		try {
			valid = await rootShellSessionValid(db, sessionToken);
		} catch {
			failedChecks += 1;
			if (failedChecks >= MAX_FAILED_CHECKS) revoke();
			return;
		}
		failedChecks = 0;
		if (!valid) revoke();
	}

	const sessionTimer = setInterval(() => {
		void checkSession();
	}, SESSION_CHECK_INTERVAL_MS);

	function toHelper(data: RawData, isBinary: boolean): void {
		if (inputStopped) return;
		// A stream of keystrokes triggers at most one check a second (SPEC.md §5.3).
		if (Date.now() - lastSessionCheck >= SESSION_CHECK_INTERVAL_MS) {
			void checkSession();
		}
		const parsed = isBinary
			? null
			: TerminalClientMessage.safeParse(safeJson(data.toString()));
		if (!parsed?.success) {
			sendJson(socket, { type: "error", code: "BAD_FRAME" });
			return;
		}
		const message = parsed.data;
		if (message.type === "resize") {
			helper.write(
				encodeJsonFrame(FrameType.RESIZE, { cols: message.cols, rows: message.rows }),
			);
			return;
		}
		const bytes = Buffer.from(message.data, "utf8");
		if (bytes.length > MAX_INPUT_FRAME_BYTES) {
			sendJson(socket, { type: "error", code: "BAD_FRAME" });
			return;
		}
		helper.write(encodeFrame(FrameType.INPUT, bytes));
	}

	function fromHelper(chunk: Buffer): void {
		let frames: ReturnType<FrameDecoder["push"]>;
		try {
			frames = decoder.push(chunk);
		} catch {
			log.error({ shellId }, "root shell helper sent a bad frame");
			endWith("exit");
			helper.destroy();
			return;
		}
		for (const frame of frames) {
			if (frame.type === FrameType.OUTPUT) {
				if (socket.readyState === socket.OPEN) {
					socket.send(frame.body, { binary: true });
					backpressure.apply();
				}
			} else if (frame.type === FrameType.EXIT) {
				endWith("exit");
				sendJson(socket, { type: "exit" });
			} else if (frame.type === FrameType.ERROR) {
				const code = (safeJson(frame.body.toString()) as { code?: unknown } | null)
					?.code;
				log.error(
					{
						shellId,
						code: typeof code === "string" && HELPER_CODE.test(code) ? code : "?",
					},
					"root shell helper refused the shell",
				);
				endWith("exit");
			}
		}
	}

	const done = new Promise<RootShellCloseReason>((resolve) => {
		let browserClosed = false;
		let helperClosed = false;
		function settle(): void {
			if (!browserClosed || !helperClosed) return;
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve(reason ?? "client");
		}

		socket.on("message", toHelper);
		socket.on("close", () => {
			endWith("client");
			browserClosed = true;
			// An ordinary close only hangs up, so the administrator's tmux survives.
			closeHelper();
			settle();
		});
		socket.on("error", () => {
			endWith("client");
			closeHelper();
		});

		helper.on("data", fromHelper);
		helper.on("error", (error: Error) => {
			if (!inputStopped)
				log.error({ err: error, shellId }, "root shell helper socket failed");
			endWith("exit");
		});
		helper.on("close", () => {
			helperClosed = true;
			endWith("exit");
			if (socket.readyState === socket.OPEN) socket.close(1000, "root shell ended");
			settle();
		});
	});

	return {
		done,
		stop() {
			if (inputStopped) return;
			endWith("api_stopped");
			closeHelper();
			socket.close(1001, "server shutting down");
		},
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
