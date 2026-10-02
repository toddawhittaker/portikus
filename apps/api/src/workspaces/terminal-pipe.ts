import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import { CloseCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { TerminalGoneReason, TerminalServerMessage } from "@portikus/events";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import type { AgentClient } from "../agent-client.js";
import { dropPresence, touchPresence } from "./presence.js";

/** How often an attached terminal refreshes its presence row (SPEC.md §6.4). */
const PRESENCE_INTERVAL_MS = 15_000;

/** How often an attached terminal re-checks that its session still exists (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 1000;

/** Pause the agent socket once this much output is waiting on the browser socket. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** Resume once the browser socket has drained back below this. */
const LOW_WATER_BYTES = 256 * 1024;

/**
 * The largest frame the API accepts from a workspace agent's terminal. The
 * agent's output chunks and its 256 KiB history replay are far smaller; the
 * agent is student-controlled, so without a cap one frame could make the API
 * buffer up to the `ws` default of 100 MiB (SPEC.md §24.1).
 */
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

/** How often a paused pipe checks whether the browser socket has drained. */
const DRAIN_POLL_MS = 50;

/** Input a browser may send before the agent socket is open. */
const MAX_QUEUED_BYTES = 64 * 1024;

/** How long the agent socket may take to answer the upgrade. */
const AGENT_HANDSHAKE_TIMEOUT_MS = 5000;

/** Close codes a WebSocket peer is allowed to send on. */
function safeCloseCode(code: number): number {
	if (code === 1000 || (code >= 1001 && code <= 1003)) return code;
	if (code >= 1007 && code <= 1011) return code;
	if (code >= 3000 && code <= 4999) return code;
	return 1000;
}

interface PipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	agent: AgentClient;
	workspaceId: string;
	terminalId: string;
	connectionId: string;
	log: FastifyBaseLogger;
	sessionToken: string | null;
	cols: number;
	rows: number;
}

/**
 * Why a terminal's session is gone, judged from the terminals unit's last
 * stop: only a stop after the terminal was created explains it (SPEC.md §9.7).
 */
export function terminalGoneReason(
	exit: { result: string; at: string } | null,
	createdAt: Date,
): TerminalGoneReason | null {
	if (!exit) return null;
	const at = Date.parse(exit.at);
	if (Number.isNaN(at) || at <= createdAt.getTime()) return null;
	return exit.result === "oom-kill" ? "out_of_memory" : "restarted";
}

/** The agent's text frames that end a terminal's attachment. */
function endingFrame(text: string): "gone" | "exit" | "server-gone" | null {
	try {
		const frame = JSON.parse(text) as {
			type?: unknown;
			code?: unknown;
			serverGone?: unknown;
		};
		// An older agent sends no `serverGone`: an ordinary exit.
		if (frame.type === "exit")
			return frame.serverGone === true ? "server-gone" : "exit";
		if (frame.type === "error" && frame.code === "TERMINAL_NOT_FOUND") return "gone";
		return null;
	} catch {
		return null;
	}
}

/** How long a server-gone `exit` waits for the terminals unit's record, and how often it asks. */
const EXIT_RECORD_WAIT_MS = 2000;
const EXIT_RECORD_POLL_MS = 250;

/**
 * The frame the browser gets when the agent ends a terminal's attachment,
 * with a reason when the terminals unit's last stop explains it (SPEC.md
 * §9.7). An `exit` whose tmux server died waits a moment for the record,
 * because the unit writes it only after its processes are gone. Any failure to find out gives the
 * agent's own frame, as before.
 */
async function explainedFrame(
	db: Kysely<Database>,
	agent: AgentClient,
	terminalId: string,
	kind: "gone" | "server-gone",
	waitMs: number,
): Promise<string> {
	const plain =
		kind === "server-gone"
			? JSON.stringify({ type: "exit" })
			: JSON.stringify({ type: "error", code: "TERMINAL_NOT_FOUND" });
	try {
		const row = await db
			.selectFrom("terminals")
			.select("created_at")
			.where("id", "=", terminalId)
			.executeTakeFirst();
		if (!row) return plain;
		const deadline = Date.now() + waitMs;
		while (true) {
			const exit = await agent.terminalsExit();
			const reason = exit ? terminalGoneReason(exit, row.created_at) : null;
			if (exit && reason) {
				const frame: TerminalServerMessage = {
					type: "error",
					code: "TERMINAL_NOT_FOUND",
					reason,
					at: exit.at,
				};
				return JSON.stringify(frame);
			}
			if (Date.now() >= deadline) return plain;
			await new Promise((resolve) => setTimeout(resolve, EXIT_RECORD_POLL_MS));
		}
	} catch {
		// An older agent has no record route; the plain frame still stands.
		return plain;
	}
}

/**
 * Stop reading the agent socket while the browser socket is backed up, so a
 * runaway process cannot fill the control plane's memory (SPEC.md §9.7).
 * Returns a function that cancels any drain poll still running.
 */
export function pipeBackpressure(
	socket: { bufferedAmount: number },
	upstream: { pause: () => void; resume: () => void },
	limits: { high: number; low: number; pollMs: number } = {
		high: HIGH_WATER_BYTES,
		low: LOW_WATER_BYTES,
		pollMs: DRAIN_POLL_MS,
	},
): { apply: () => void; cancel: () => void } {
	let drainTimer: NodeJS.Timeout | null = null;

	// Resumes a paused upstream too: a paused socket never reads the agent's
	// close reply, so closing it would hang for ws's 30 s close timeout.
	function cancel(): void {
		if (!drainTimer) return;
		clearInterval(drainTimer);
		drainTimer = null;
		upstream.resume();
	}

	return {
		apply() {
			if (drainTimer) return;
			if (socket.bufferedAmount <= limits.high) return;
			upstream.pause();
			drainTimer = setInterval(() => {
				if (socket.bufferedAmount >= limits.low) return;
				cancel();
			}, limits.pollMs);
		},
		cancel,
	};
}

/**
 * Forward frames between one browser socket and one agent attachment. Frames
 * are carried unchanged in both directions (SPEC.md §9.7).
 */
export async function pipeTerminal(options: PipeOptions): Promise<void> {
	const {
		db,
		socket,
		agent,
		workspaceId,
		terminalId,
		connectionId,
		sessionToken,
		log,
	} = options;

	log.debug({ workspaceId, terminalId, connectionId }, "terminal pipe opened");

	const upstream = new WebSocketClient(
		agent.attachUrl(terminalId, options.cols, options.rows),
		{
			headers: { authorization: agent.authHeader() },
			handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
			maxPayload: MAX_AGENT_FRAME_BYTES,
		},
	);

	// Frames can arrive before the agent socket finishes connecting.
	const queued: string[] = [];
	let queuedBytes = 0;
	let closed = false;
	let lastSessionCheck = Date.now();
	let explaining: Promise<void> = Promise.resolve();
	// The agent is student-controlled, so it gets one record lookup per
	// connection and no more (SPEC.md §24).
	let ending = false;

	const backpressure = pipeBackpressure(socket, upstream);

	const presenceTimer = setInterval(() => {
		void touchPresence(db, connectionId).catch(() => {});
	}, PRESENCE_INTERVAL_MS);

	async function sessionStillValid(): Promise<boolean> {
		lastSessionCheck = Date.now();
		const user = sessionToken ? await loadSession(db, sessionToken) : null;
		if (user && !sessionGate(user)) return true;
		socket.close(CloseCode.SESSION_ENDED, "session revoked");
		return false;
	}

	const sessionTimer = setInterval(() => {
		void sessionStillValid().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	const done = new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(presenceTimer);
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve();
		}

		socket.on("message", (data: RawData) => {
			const text = data.toString();
			// Revocation must take effect at once, but one check a second is
			// enough for a stream of keystrokes (SPEC.md §5.3).
			if (Date.now() - lastSessionCheck >= SESSION_CHECK_INTERVAL_MS) {
				void sessionStillValid().catch(() => {});
			}
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.send(text);
			} else if (upstream.readyState === WebSocketClient.CONNECTING) {
				queuedBytes += Buffer.byteLength(text);
				if (queuedBytes > MAX_QUEUED_BYTES) {
					socket.close(1009, "too much input before the terminal was ready");
					return;
				}
				queued.push(text);
			}
		});

		socket.on("close", (code: number, reason: Buffer) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), reason.toString());
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("open", () => {
			for (const frame of queued.splice(0)) upstream.send(frame);
			queuedBytes = 0;
		});

		upstream.on("message", (data: RawData, isBinary: boolean) => {
			if (socket.readyState !== socket.OPEN) return;
			if (ending) {
				// Nothing follows the end of a terminal; the agent is told to stop.
				upstream.close(1000, "terminal ended");
				return;
			}
			const kind = isBinary ? null : endingFrame(data.toString());
			if (kind === "exit") {
				// An ordinary exit closes the pane at once, with no lookup.
				ending = true;
				socket.send(JSON.stringify({ type: "exit" }));
				return;
			}
			if (kind) {
				ending = true;
				const waitMs = kind === "server-gone" ? EXIT_RECORD_WAIT_MS : 0;
				explaining = explainedFrame(db, agent, terminalId, kind, waitMs).then(
					(frame) => {
						if (socket.readyState === socket.OPEN) socket.send(frame);
					},
				);
				return;
			}
			socket.send(isBinary ? toBuffer(data) : data.toString(), { binary: isBinary });
			backpressure.apply();
		});

		upstream.on("close", (code: number, reason: Buffer) => {
			// The agent closes straight after saying the session is gone, so
			// the explanation must reach the browser before the close does.
			void explaining.then(() => {
				if (socket.readyState === socket.OPEN) {
					socket.close(safeCloseCode(code), reason.toString());
				}
				finish();
			});
		});

		upstream.on("error", (error: Error) => {
			// The browser closing first aborts a still-connecting agent socket,
			// which is the normal path and not a failure.
			const line = { err: error, workspaceId, terminalId, connectionId };
			if (closed) log.info(line, "terminal agent socket failed");
			else log.error(line, "terminal agent socket failed");
			if (socket.readyState === socket.OPEN) {
				socket.close(CloseCode.SERVER_ERROR, "agent unavailable");
			}
			finish();
		});
	});

	await done;
	log.debug({ workspaceId, terminalId, connectionId }, "terminal pipe closed");
	try {
		await dropPresence(db, connectionId);
	} catch (error) {
		log.error({ err: error, connectionId }, "failed to delete workspace connection");
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

export interface OneWayPipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	/** The agent socket to read from, and its authorization header. */
	url: string;
	authHeader: string;
	workspaceId: string;
	sessionToken: string | null;
	log: FastifyBaseLogger;
	/** The fixed reason the browser hears when the agent closes. */
	closeReason: (safeCode: number) => string;
	/** The log message for an agent socket error. */
	failureMessage: string;
}

/**
 * Forward frames from one agent socket to one browser socket. Nothing travels
 * the other way: a frame the browser sends is dropped, so a hostile page
 * cannot reach the agent through this socket (SPEC.md §24.6).
 */
export async function pipeOneWay(options: OneWayPipeOptions): Promise<void> {
	const { db, socket, workspaceId, sessionToken, log } = options;

	const upstream = new WebSocketClient(options.url, {
		headers: { authorization: options.authHeader },
		handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
		maxPayload: MAX_AGENT_FRAME_BYTES,
	});

	let closed = false;
	const backpressure = pipeBackpressure(socket, upstream);

	async function sessionStillValid(): Promise<void> {
		const user = sessionToken ? await loadSession(db, sessionToken) : null;
		if (user && !sessionGate(user)) return;
		socket.close(CloseCode.SESSION_ENDED, "session revoked");
	}

	const sessionTimer = setInterval(() => {
		void sessionStillValid().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	await new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve();
		}

		socket.on("message", () => {});

		// The browser's own reason bytes are never sent on: the agent is told
		// only that the browser went away (SPEC.md §24.1).
		socket.on("close", (code: number) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), "browser closed");
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("message", (data: RawData) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(data.toString());
			backpressure.apply();
		});

		// The agent's reason bytes are never relayed; the browser gets our own
		// words for the close (SPEC.md §24.1).
		upstream.on("close", (code: number) => {
			if (socket.readyState === socket.OPEN) {
				const safe = safeCloseCode(code);
				socket.close(safe, options.closeReason(safe));
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			// The slug is a student-chosen name, so it stays out of the log.
			const line = { err: error, workspaceId };
			if (closed) log.info(line, options.failureMessage);
			else log.error(line, options.failureMessage);
			if (socket.readyState === socket.OPEN) {
				socket.close(CloseCode.SERVER_ERROR, "agent unavailable");
			}
			finish();
		});
	});
}
