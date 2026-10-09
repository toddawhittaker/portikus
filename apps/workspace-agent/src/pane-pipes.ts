/**
 * Noticing `clear` the moment it happens (SPEC.md §9.7). tmux keeps the
 * erase-scrollback sequence to itself, and the pane poll only sees the
 * history drop to nothing if no new output refills it first, so
 * `clear && npm test` used to keep the old scrollback in the browser.
 *
 * tmux's `pipe-pane -O` hands a copy of a pane's output to a command. Each
 * pane gets its own FIFO in the agent's runtime directory and a `cat` that
 * writes into it; the agent reads every FIFO and scans the bytes for
 * ESC [ 3 J. One shared FIFO for every pane is not practical: tmux starts a
 * process per pipe either way, and those writers cannot tag their chunks
 * atomically, so per-pane FIFOs cost nothing extra and need no tagging.
 *
 * The bytes are terminal output. They are scanned and dropped at once, never
 * logged and never kept (STACK.md §15, ADR 0012); the scanner holds only how
 * much of the sequence it has seen so far.
 */
import { execFile } from "node:child_process";
import { constants, open as openCallback } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { listSessions, pipePane, sessionName, type TmuxServer } from "./tmux.js";

const run = promisify(execFile);
const openFd = promisify(openCallback);

/**
 * How often to look for terminals whose shell exited on its own. Nothing
 * else notices an unattached pane ending, and each one holds a reader, an fd
 * and a FIFO until it is swept.
 */
const SWEEP_MS = 10_000;

/** The erase-scrollback sequence `clear` sends. */
const CLEAR_SCROLLBACK = [0x1b, 0x5b, 0x33, 0x4a];

/**
 * Finds ESC [ 3 J in a stream of chunks, including one split across chunks.
 * Every byte of the sequence is different, so on a mismatch the only partial
 * match left is a fresh ESC.
 */
export class ClearScanner {
	private matched = 0;

	/** True when the sequence ends somewhere in this chunk. */
	feed(chunk: Uint8Array): boolean {
		let found = false;
		for (const byte of chunk) {
			if (byte === CLEAR_SCROLLBACK[this.matched]) {
				this.matched += 1;
				if (this.matched === CLEAR_SCROLLBACK.length) {
					found = true;
					this.matched = 0;
				}
			} else {
				this.matched = byte === CLEAR_SCROLLBACK[0] ? 1 : 0;
			}
		}
		return found;
	}
}

export interface PanePipesOptions {
	/** Where the FIFOs live; `/run/portikus/panes` in a workspace. */
	dir: string;
	server: TmuxServer;
	/** Called when a terminal's output erased its scrollback. */
	onClear: (terminalId: string) => void;
	log: FastifyBaseLogger;
	/** How often to sweep ended terminals; tests shorten it. */
	sweepMs?: number;
}

/** The FIFO readers for every terminal the agent knows about. */
export class PanePipes {
	private readonly readers = new Map<string, Socket>();
	private readonly sweepTimer: NodeJS.Timeout;

	constructor(private readonly options: PanePipesOptions) {
		this.sweepTimer = setInterval(() => {
			void this.sweep();
		}, options.sweepMs ?? SWEEP_MS);
		this.sweepTimer.unref();
	}

	/**
	 * Start (or restart) the pipe for one terminal. Replaces any pipe the pane
	 * already has, which after an agent restart is the old agent's dead one.
	 * Never throws: without the pipe the pane poll still catches most clears.
	 */
	async start(terminalId: string): Promise<void> {
		try {
			await this.startPipe(terminalId);
		} catch (error) {
			this.stop(terminalId);
			this.options.log.warn(
				{ terminalId, error: error instanceof Error ? error.message : error },
				"could not watch a terminal for clear",
			);
		}
	}

	private async startPipe(terminalId: string): Promise<void> {
		const name = sessionName(terminalId);
		this.stopReader(terminalId);
		const path = join(this.options.dir, terminalId);
		await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
		await rm(path, { force: true });
		await run("mkfifo", ["-m", "600", path]);
		// Read and write: the open never blocks, and the FIFO never reports
		// end of file while `cat` is being replaced.
		const fd = await openFd(path, constants.O_RDWR | constants.O_NONBLOCK);
		const reader = new Socket({ fd, readable: true, writable: false });
		const scanner = new ClearScanner();
		reader.on("data", (chunk: Buffer) => {
			if (scanner.feed(chunk)) this.options.onClear(terminalId);
		});
		reader.on("error", () => {
			// The poll still catches a clear; the error text carries no bytes,
			// but there is nothing to say that the fallback does not cover.
		});
		this.readers.set(terminalId, reader);
		await pipePane(name, path, this.options.server);
	}

	/** Start pipes for terminals that outlived the previous agent. */
	async adopt(terminalIds: readonly string[]): Promise<void> {
		for (const id of terminalIds) await this.start(id);
	}

	/** Stop reading a closed terminal's FIFO and remove it. */
	stop(terminalId: string): void {
		this.stopReader(terminalId);
		void rm(join(this.options.dir, terminalId), { force: true }).catch(() => undefined);
	}

	stopAll(): void {
		clearInterval(this.sweepTimer);
		for (const id of [...this.readers.keys()]) this.stop(id);
	}

	/** Stop the pipes of terminals whose session has ended. */
	async sweep(): Promise<void> {
		if (this.readers.size === 0) return;
		let live: Set<string>;
		try {
			live = new Set((await listSessions(this.options.server)).map((s) => s.id));
		} catch {
			// A missed sweep only delays the cleanup to the next one.
			return;
		}
		for (const id of [...this.readers.keys()]) {
			if (!live.has(id)) this.stop(id);
		}
	}

	private stopReader(terminalId: string): void {
		this.readers.get(terminalId)?.destroy();
		this.readers.delete(terminalId);
	}
}
