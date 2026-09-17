import type { WebSocket } from "@fastify/websocket";
import {
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_INPUT_FRAME_BYTES,
} from "@portikus/contracts";
import { TerminalClientMessage, type TerminalServerMessage } from "@portikus/events";
import type { FastifyBaseLogger } from "fastify";
import { type IPty, spawn } from "node-pty";
import { AgentFailure, attachArgs, hasSession } from "./tmux.js";

/** Pause the PTY once this much output is waiting on the socket (SPEC.md §9.7). */
const HIGH_WATER_BYTES = 1024 * 1024;

/** Resume once the socket has drained back below this (SPEC.md §9.7). */
const LOW_WATER_BYTES = 256 * 1024;

/** How often a paused attachment checks whether its socket has drained. */
const DRAIN_POLL_MS = 50;

/**
 * How long a new attachment holds input while its `tmux attach-session`
 * starts up. A tmux client discards anything written before it is ready, so
 * the queue drains on the first byte of output or when this expires,
 * whichever comes first.
 */
const INPUT_QUEUE_MS = 500;

/** Most input one attachment will hold while tmux starts. */
const INPUT_QUEUE_MAX_BYTES = 64 * 1024;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface Attachment {
	socket: WebSocket;
	/** Null only while the slot is reserved and the PTY is starting. */
	pty: IPty | null;
	drainTimer: NodeJS.Timeout | null;
	/** Input held until tmux is ready; null once the queue has been flushed. */
	pendingInput: string[] | null;
	pendingBytes: number;
	pendingTimer: NodeJS.Timeout | null;
}

export interface AttachOptions {
	cols?: number;
	rows?: number;
}

function sendText(socket: WebSocket, message: TerminalServerMessage): void {
	socket.send(JSON.stringify(message));
}

/**
 * The agent's live terminals: one tmux session each, with the browser
 * attachments currently sharing it (SPEC.md §9.5, §9.7). tmux owns the shell,
 * so dropping every attachment leaves the session running.
 */
export class TerminalRegistry {
	private readonly attachments = new Map<string, Set<Attachment>>();

	constructor(
		private readonly homeDir: string,
		private readonly log: FastifyBaseLogger,
		private readonly socketName?: string,
	) {}

	/** How many browsers are attached to one terminal. */
	countAttachments(id: string): number {
		return this.attachments.get(id)?.size ?? 0;
	}

	/**
	 * Attach one browser socket to a terminal by running its own
	 * `tmux attach-session` in a PTY.
	 */
	async attach(id: string, socket: WebSocket, options: AttachOptions): Promise<void> {
		const existing = this.attachments.get(id) ?? new Set<Attachment>();
		if (existing.size >= MAX_ATTACHMENTS_PER_TERMINAL) {
			throw new AgentFailure(
				"ATTACHMENT_LIMIT",
				"this terminal already has the maximum number of attachments",
			);
		}
		// Take the slot before the first await so that two attachments racing
		// each other cannot both pass the limit check.
		const attachment: Attachment = {
			socket,
			pty: null,
			drainTimer: null,
			pendingInput: [],
			pendingBytes: 0,
			pendingTimer: null,
		};
		existing.add(attachment);
		this.attachments.set(id, existing);

		if (!(await hasSession(id, this.socketName))) {
			this.forget(id, attachment);
			throw new AgentFailure("TERMINAL_NOT_FOUND", "no such terminal");
		}

		const pty = spawn("tmux", attachArgs(id, this.socketName), {
			name: "xterm-256color",
			cols: options.cols ?? DEFAULT_COLS,
			rows: options.rows ?? DEFAULT_ROWS,
			cwd: this.homeDir,
			env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
		});

		attachment.pty = pty;
		this.log.debug(
			{ terminalId: id, pid: pty.pid, cols: pty.cols, rows: pty.rows },
			"pty spawned",
		);

		// tmux is only ready to accept input once it has drawn something, so
		// release the queue on the first output or on the timer.
		attachment.pendingTimer = setTimeout(() => {
			this.flushPendingInput(attachment);
		}, INPUT_QUEUE_MS);

		pty.onData((data) => {
			this.flushPendingInput(attachment);
			socket.send(Buffer.from(data, "utf8"), { binary: true });
			this.applyBackpressure(attachment);
		});

		pty.onExit(() => {
			this.forget(id, attachment);
			sendText(socket, { type: "exit" });
			socket.close(1000, "terminal exited");
		});

		socket.on("message", (raw: Buffer | string) => {
			this.onMessage(attachment, raw);
		});

		socket.on("close", () => {
			this.forget(id, attachment);
			this.log.debug({ terminalId: id, pid: pty.pid }, "terminal detached");
			// Killing the attach process only detaches; the session lives on.
			try {
				pty.kill();
			} catch {
				// The process may already be gone.
			}
		});
	}

	/** Close every attachment to a terminal, used when the terminal is deleted. */
	closeAll(id: string, code: number, reason: string): void {
		for (const attachment of this.attachments.get(id) ?? []) {
			attachment.socket.close(code, reason);
		}
		this.attachments.delete(id);
	}

	/** Tear down every attachment on shutdown. */
	closeEverything(): void {
		for (const id of [...this.attachments.keys()]) {
			this.closeAll(id, 1001, "agent shutting down");
		}
	}

	/** Write any input that arrived before tmux was ready, in order. */
	private flushPendingInput(attachment: Attachment): void {
		if (attachment.pendingTimer) {
			clearTimeout(attachment.pendingTimer);
			attachment.pendingTimer = null;
		}
		const pending = attachment.pendingInput;
		attachment.pendingInput = null;
		attachment.pendingBytes = 0;
		if (!pending || !attachment.pty) return;
		for (const chunk of pending) attachment.pty.write(chunk);
	}

	private forget(id: string, attachment: Attachment): void {
		if (attachment.pendingTimer) {
			clearTimeout(attachment.pendingTimer);
			attachment.pendingTimer = null;
		}
		if (attachment.drainTimer) {
			clearInterval(attachment.drainTimer);
			attachment.drainTimer = null;
		}
		const set = this.attachments.get(id);
		if (!set) return;
		set.delete(attachment);
		if (set.size === 0) this.attachments.delete(id);
	}

	/**
	 * Stop reading the PTY while the socket is backed up, so a runaway process
	 * cannot fill the agent's memory (SPEC.md §9.7).
	 */
	private applyBackpressure(attachment: Attachment): void {
		if (attachment.drainTimer) return;
		if (attachment.socket.bufferedAmount <= HIGH_WATER_BYTES) return;
		const pty = attachment.pty;
		if (!pty) return;

		pty.pause();
		attachment.drainTimer = setInterval(() => {
			if (attachment.socket.bufferedAmount >= LOW_WATER_BYTES) return;
			if (attachment.drainTimer) clearInterval(attachment.drainTimer);
			attachment.drainTimer = null;
			pty.resume();
		}, DRAIN_POLL_MS);
	}

	private onMessage(attachment: Attachment, raw: Buffer | string): void {
		const { socket, pty } = attachment;
		if (!pty) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString());
		} catch {
			this.rejectFrame(socket);
			return;
		}

		const message = TerminalClientMessage.safeParse(parsed);
		if (!message.success) {
			this.rejectFrame(socket);
			return;
		}

		if (message.data.type === "input") {
			if (Buffer.byteLength(message.data.data, "utf8") > MAX_INPUT_FRAME_BYTES) {
				socket.close(1009, "input frame too large");
				return;
			}
			if (attachment.pendingInput) {
				const size = Buffer.byteLength(message.data.data, "utf8");
				if (attachment.pendingBytes + size > INPUT_QUEUE_MAX_BYTES) {
					this.log.warn(
						{ pid: pty.pid, pendingBytes: attachment.pendingBytes },
						"dropping early terminal input: queue full",
					);
					return;
				}
				attachment.pendingInput.push(message.data.data);
				attachment.pendingBytes += size;
				return;
			}
			pty.write(message.data.data);
			return;
		}

		try {
			pty.resize(message.data.cols, message.data.rows);
			this.log.debug(
				{ pid: pty.pid, cols: message.data.cols, rows: message.data.rows },
				"terminal resized",
			);
		} catch (error) {
			this.log.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"terminal resize failed",
			);
		}
	}

	private rejectFrame(socket: WebSocket): void {
		sendText(socket, { type: "error", code: "BAD_FRAME" });
		socket.close(1008, "malformed frame");
	}
}
