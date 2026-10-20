/**
 * Language servers for code help (SPEC.md §13.6): one process per project
 * and server id, started by the browser's socket and stopped when it is no
 * longer used. The agent reads only the first browser message; every other
 * message passes through unread, and none is ever logged (STACK.md §15).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { WebSocket } from "@fastify/websocket";
import {
	CloseCode,
	LANGUAGE_SERVER_MAX_FRAME_BYTES,
	type LanguageServerId,
	MAX_LANGUAGE_SERVERS_PER_WORKSPACE,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import type { FastifyBaseLogger } from "fastify";
import { LANGUAGE_SERVERS, type LanguageServerEntry } from "./language-server-table.js";
import { killProcessTree, readStartTime } from "./process-tree.js";
import { encodeMessage, FramingError, MessageReader } from "./stdio-messages.js";

// Same reasons and values as a Check (checks-route.ts, ADR 0035): the
// kernel picks a server before the agent when memory runs out, and a fork
// bomb runs out of processes before the agent cannot fork.
const OOM_SCORE_ADJ = "500";
const MAX_PROCESSES = 1700;

const LINGER_MS = 60_000;
const IDLE_MS = 15 * 60_000;
const STOP_GRACE_MS = 3000;
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 3;
const UNAVAILABLE_MS = 5 * 60_000;

/** JSON-RPC's code for a request that was valid but failed (LSP 3.17). */
const REQUEST_FAILED = -32803;

/** Close reasons are fixed strings; nothing from a server reaches them. */
const REASON = {
	replaced: "opened in another window",
	idle: "no messages for 15 minutes",
	evicted: "stopped to make room for another language server",
	// The API forwards these two exactly (LANGUAGE_SERVER_CLOSE_REASONS in
	// packages/contracts) and replaces every other reason with its own.
	crashed: "crashed",
	outOfMemory: "crashed: may have run out of memory",
	tooManyCrashes: "language server crashed too often",
	notInstalled: "language server is not installed",
	notInitialize: "the first message must be initialize",
	binary: "only text frames are accepted",
	malformed: "language server sent a malformed message",
	shutdown: "workspace agent is stopping",
} as const;

export interface LanguageServerHostOptions {
	log: FastifyBaseLogger;
	/** Overrides the table, so a test can run a fake server. For tests. */
	table?: Record<LanguageServerId, LanguageServerEntry>;
	/** Overrides the process cap, since it counts every task the user owns. For tests. */
	maxProcesses?: number;
	/** Overrides the timings below. For tests. */
	lingerMs?: number;
	idleMs?: number;
	stopGraceMs?: number;
	crashWindowMs?: number;
	unavailableMs?: number;
	maxFrameBytes?: number;
}

interface Session {
	key: string;
	entry: LanguageServerEntry;
	child: ChildProcess;
	startTime: Promise<string | null>;
	socket: WebSocket | null;
	lastUsed: number;
	/** Set once the agent decided to stop it, so its exit is not a crash. */
	stopping: boolean;
	exited: Promise<void>;
	lingerTimer: NodeJS.Timeout | null;
	idleTimer: NodeJS.Timeout | null;
}

function sessionKey(slug: string, server: LanguageServerId): string {
	return `${slug}\u0000${server}`;
}

function close(socket: WebSocket | null, code: number, reason: string): void {
	if (!socket) return;
	if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
		socket.close(code, reason);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `ours` over `theirs`, object by object; a value of ours replaces theirs. */
export function mergeOver(
	theirs: unknown,
	ours: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = isObject(theirs) ? { ...theirs } : {};
	for (const [name, value] of Object.entries(ours)) {
		merged[name] = isObject(value) ? mergeOver(merged[name], value) : value;
	}
	return merged;
}

/**
 * The browser's `initialize`, pointed at the project's real path and the
 * agent's process (SPEC.md §13.6). Null when the message is not one.
 */
export function rewriteInitialize(
	text: string,
	options: { rootPath: string; slug: string; entry: LanguageServerEntry; pid: number },
): string | null {
	let message: unknown;
	try {
		message = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		!isObject(message) ||
		message.method !== "initialize" ||
		message.id === undefined
	) {
		return null;
	}
	const params = isObject(message.params) ? message.params : {};
	const rootUri = pathToFileURL(options.rootPath).href;
	return JSON.stringify({
		...message,
		params: {
			...params,
			processId: options.pid,
			rootUri,
			rootPath: options.rootPath,
			workspaceFolders: [{ uri: rootUri, name: options.slug }],
			capabilities: mergeOver(params.capabilities, options.entry.clientCapabilities),
			initializationOptions: mergeOver(
				params.initializationOptions,
				options.entry.initializationOptions,
			),
		},
	});
}

/**
 * Messages that arrive while the route is still checking the project; a
 * WebSocket drops a message no listener is there for.
 */
export class EarlyMessages {
	readonly messages: Array<[Buffer, boolean]> = [];
	private readonly listener = (data: Buffer, isBinary: boolean): void => {
		this.messages.push([data, isBinary]);
	};

	constructor(private readonly socket: WebSocket) {
		socket.on("message", this.listener);
	}

	stop(): void {
		this.socket.off("message", this.listener);
	}
}

/** Every language server this agent runs, keyed by project and server id. */
export class LanguageServerHost {
	private readonly sessions = new Map<string, Session>();
	private readonly crashes = new Map<string, number[]>();
	private readonly unavailableUntil = new Map<string, number>();
	private readonly table: Record<LanguageServerId, LanguageServerEntry>;
	private readonly log: FastifyBaseLogger;

	constructor(private readonly options: LanguageServerHostOptions) {
		this.table = options.table ?? LANGUAGE_SERVERS;
		this.log = options.log;
	}

	/** How many servers are running, for tests and capacity checks. */
	running(): string[] {
		return [...this.sessions.keys()];
	}

	/**
	 * Serve one browser socket. `early` holds what arrived before this call;
	 * the listeners go on before anything is awaited, so nothing is lost.
	 */
	async attach(
		socket: WebSocket,
		target: {
			slug: string;
			server: LanguageServerId;
			/** The real path: the server's working directory. */
			projectPath: string;
			/** The path as the API reports it, which the browser maps URIs against. */
			rootPath: string;
		},
		early: EarlyMessages,
	): Promise<void> {
		const key = sessionKey(target.slug, target.server);
		const entry = this.table[target.server];
		const queued: Buffer[] = [];
		let session: Session | null = null;
		let initialized = false;
		let socketClosed = false;

		const deliver = (data: Buffer): void => {
			if (!session || session.stopping) return;
			session.lastUsed = Date.now();
			this.armIdle(session);
			if (initialized) {
				this.write(session, data.toString("utf8"));
				return;
			}
			const rewritten = rewriteInitialize(data.toString("utf8"), {
				rootPath: target.rootPath,
				slug: target.slug,
				entry,
				pid: process.pid,
			});
			if (rewritten === null) {
				close(socket, CloseCode.POLICY, REASON.notInitialize);
				void this.stop(session);
				return;
			}
			initialized = true;
			this.write(session, rewritten);
		};

		const onMessage = (data: Buffer, isBinary: boolean): void => {
			if (isBinary) {
				close(socket, CloseCode.POLICY, REASON.binary);
				return;
			}
			if (session) deliver(data);
			else queued.push(data);
		};
		early.stop();
		socket.on("message", onMessage);
		for (const [data, isBinary] of early.messages) onMessage(data, isBinary);
		socket.on("close", () => {
			socketClosed = true;
			if (session && session.socket === socket) {
				session.socket = null;
				this.armLinger(session);
			}
		});

		const blockedUntil = this.unavailableUntil.get(key) ?? 0;
		if (Date.now() < blockedUntil) {
			close(socket, CloseCode.LANGUAGE_SERVER_UNAVAILABLE, REASON.tooManyCrashes);
			return;
		}

		// A second window restarts the server: a running one has already been
		// initialized, and LSP allows that only once.
		const previous = this.sessions.get(key);
		if (previous) {
			close(previous.socket, CloseCode.LANGUAGE_SERVER_REPLACED, REASON.replaced);
			void this.stop(previous);
		}

		let command: Awaited<ReturnType<LanguageServerEntry["resolve"]>>;
		try {
			command = await entry.resolve(target.projectPath);
		} catch (error) {
			this.log.warn(
				{ server: target.server, error: errorMessage(error) },
				"language server lookup failed",
			);
			command = null;
		}
		if (command === null) {
			close(socket, CloseCode.LANGUAGE_SERVER_UNAVAILABLE, REASON.notInstalled);
			return;
		}
		if (socketClosed) return;
		// Another socket for the same pair may have started while this one
		// looked up its command; the later one wins.
		const raced = this.sessions.get(key);
		if (raced) {
			close(raced.socket, CloseCode.LANGUAGE_SERVER_REPLACED, REASON.replaced);
			void this.stop(raced);
		}
		if (entry.counted) this.makeRoom(key);

		const maxProcesses = this.options.maxProcesses ?? MAX_PROCESSES;
		const child = spawn(
			"prlimit",
			[
				`--nproc=${maxProcesses}:${maxProcesses}`,
				"--",
				"choom",
				"-n",
				OOM_SCORE_ADJ,
				"--",
				command.command,
				...command.args,
			],
			{
				cwd: target.projectPath,
				env: { ...process.env, ...command.env },
				stdio: ["pipe", "pipe", "pipe"],
				// Its own session, so killing the tree also reaches what it started.
				detached: true,
			},
		);
		const started: Session = {
			key,
			entry,
			child,
			startTime: Promise.resolve(null),
			socket,
			lastUsed: Date.now(),
			stopping: false,
			exited: new Promise((resolve) => child.once("exit", () => resolve())),
			lingerTimer: null,
			idleTimer: null,
		};
		this.sessions.set(key, started);
		session = started;
		if (child.pid !== undefined) started.startTime = readStartTime(child.pid);

		// Read and dropped: a server's stderr can quote the student's code.
		child.stderr?.resume();
		child.stdin?.on("error", () => {});
		child.on("error", (error) => {
			this.log.warn(
				{ server: target.server, error: errorMessage(error) },
				"language server failed to start",
			);
			started.stopping = true;
			this.forget(started);
			close(started.socket, CloseCode.LANGUAGE_SERVER_UNAVAILABLE, REASON.notInstalled);
		});
		child.on("exit", (code, signal) => this.exited(started, code, signal));

		const reader = new MessageReader(
			this.options.maxFrameBytes ?? LANGUAGE_SERVER_MAX_FRAME_BYTES,
			(message) => {
				const open = started.socket;
				if (started.stopping || !open || open.readyState !== open.OPEN) return;
				if (message.kind === "message") {
					open.send(message.body);
					return;
				}
				if (message.id === null) return;
				open.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: REQUEST_FAILED, message: "response too large" },
					}),
				);
			},
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (started.stopping) return;
			try {
				reader.push(chunk);
			} catch (error) {
				if (!(error instanceof FramingError)) throw error;
				close(started.socket, CloseCode.LANGUAGE_SERVER_CRASHED, REASON.malformed);
				void this.stop(started);
			}
		});

		this.armIdle(started);
		if (socketClosed) {
			started.socket = null;
			this.armLinger(started);
			return;
		}
		for (const data of queued.splice(0)) deliver(data);
	}

	/** Stop every server, for shutdown. */
	async closeEverything(): Promise<void> {
		const all = [...this.sessions.values()];
		for (const session of all)
			close(session.socket, CloseCode.SERVER_ERROR, REASON.shutdown);
		await Promise.all(all.map((session) => this.stop(session)));
	}

	/** At most MAX_LANGUAGE_SERVERS_PER_WORKSPACE counted servers; the least recently used goes. */
	private makeRoom(key: string): void {
		const counted = [...this.sessions.values()].filter(
			(session) => session.entry.counted && session.key !== key,
		);
		while (counted.length >= MAX_LANGUAGE_SERVERS_PER_WORKSPACE) {
			counted.sort((a, b) => a.lastUsed - b.lastUsed);
			const oldest = counted.shift() as Session;
			close(oldest.socket, CloseCode.LANGUAGE_SERVER_IDLE, REASON.evicted);
			void this.stop(oldest);
		}
	}

	private write(session: Session, body: string): void {
		const stdin = session.child.stdin;
		if (stdin && !stdin.destroyed && stdin.writable) stdin.write(encodeMessage(body));
	}

	private armIdle(session: Session): void {
		if (session.idleTimer) clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(() => {
			// Closing starts the linger, which stops the server (SPEC.md §13.6).
			close(session.socket, CloseCode.LANGUAGE_SERVER_IDLE, REASON.idle);
		}, this.options.idleMs ?? IDLE_MS);
		session.idleTimer.unref();
	}

	private armLinger(session: Session): void {
		if (session.lingerTimer) clearTimeout(session.lingerTimer);
		session.lingerTimer = setTimeout(() => {
			if (session.socket === null) void this.stop(session);
		}, this.options.lingerMs ?? LINGER_MS);
		session.lingerTimer.unref();
	}

	private forget(session: Session): void {
		if (session.idleTimer) clearTimeout(session.idleTimer);
		if (session.lingerTimer) clearTimeout(session.lingerTimer);
		if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
	}

	/** `shutdown`, then `exit`, then the whole tree killed after the grace period. */
	private async stop(session: Session): Promise<void> {
		if (session.stopping) return session.exited;
		session.stopping = true;
		this.forget(session);
		this.write(
			session,
			JSON.stringify({ jsonrpc: "2.0", id: "portikus-shutdown", method: "shutdown" }),
		);
		this.write(session, JSON.stringify({ jsonrpc: "2.0", method: "exit" }));
		session.child.stdin?.end();
		const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = await Promise.race([
			session.exited.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), grace);
			}),
		]);
		clearTimeout(timer);
		if (!timedOut) return;
		const pid = session.child.pid;
		if (pid === undefined) return;
		try {
			const start = await session.startTime;
			await killProcessTree(pid, start ?? undefined, grace);
		} catch (error) {
			this.log.warn({ error: errorMessage(error) }, "could not stop a language server");
		}
	}

	private exited(
		session: Session,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		this.forget(session);
		if (session.stopping) return;
		session.stopping = true;
		const now = Date.now();
		const window = this.options.crashWindowMs ?? CRASH_WINDOW_MS;
		const recent = (this.crashes.get(session.key) ?? []).filter(
			(at) => now - at < window,
		);
		recent.push(now);
		this.crashes.set(session.key, recent);
		this.log.warn({ server: session.entry.id, code, signal }, "language server exited");
		if (recent.length >= CRASH_LIMIT) {
			this.crashes.delete(session.key);
			this.unavailableUntil.set(
				session.key,
				now + (this.options.unavailableMs ?? UNAVAILABLE_MS),
			);
			close(
				session.socket,
				CloseCode.LANGUAGE_SERVER_UNAVAILABLE,
				REASON.tooManyCrashes,
			);
			return;
		}
		// The agent sends SIGKILL only after its own stop, which is not a
		// crash; any other SIGKILL is most likely the out-of-memory killer.
		const reason = signal === "SIGKILL" ? REASON.outOfMemory : REASON.crashed;
		close(session.socket, CloseCode.LANGUAGE_SERVER_CRASHED, reason);
	}
}
