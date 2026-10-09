import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { WebSocket } from "@fastify/websocket";
import type {
	AgentListeningService,
	GitDiff,
	GitStatus,
	SearchMatch,
} from "@portikus/contracts";
import { WATCH_SKIP_NAMES } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
	checkPath,
	type FakeDirectory,
	FakeFileError,
	type FakeNode,
	FILE_ERROR_STATUS,
	nodeKey,
} from "./fs-model.js";

/** What the fake answers the Git routes of one project with. */
export interface FakeGitAnswer {
	status?: GitStatus;
	diffs?: Record<string, GitDiff>;
}

/** One archive of the fake: a copy of the project's entries at that time. */
export interface FakeRecoveryPoint {
	key: string;
	projectId: string;
	sha256: string;
	entries: Map<string, FakeNode>;
}

type StorageFigure = { usedBytes: number; totalBytes: number } | null;

/** The three storage classes `/usage` reports (SPEC.md §19.2). */
export interface FakeStorage {
	home: StorageFigure;
	docker: StorageFigure;
	recovery: StorageFigure;
}

/**
 * One process of the fake. `ignoresTerm` survives SIGTERM, so the browser
 * offers Force stop; `stoppable` false is a protected process.
 */
export interface FakeProcess {
	pid: number;
	command: string;
	cpuPercent: number;
	residentBytes: number;
	startTicks: number;
	stoppable: boolean;
	commandLine: string | null;
	ignoresTerm?: boolean;
}

/** What a workspace runs until a test says otherwise. */
export function defaultProcesses(): FakeProcess[] {
	return [
		{
			pid: 7,
			command: "node",
			cpuPercent: 1.5,
			residentBytes: 4096,
			startTicks: 100,
			stoppable: true,
			commandLine: "node server.js --port 3000",
		},
	];
}

/** An empty repository answer, so an unseeded project still reads. */
export function emptyStatus(): GitStatus {
	return {
		repo: false,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [],
		ignored: [],
		truncated: false,
	};
}

/**
 * Everything one fake agent holds in memory, shared by its route files, and
 * the helpers more than one route file needs.
 */
export function createFakeAgentState(token: string) {
	const terminals = new Map<
		string,
		{
			cwd: string;
			theme: string;
			timezone: string;
			agent?: string;
			institutionalEnv?: Record<string, string>;
		}
	>();
	const creates: Array<Record<string, unknown>> = [];
	const requests: Array<{ method: string; url: string }> = [];
	// Every attachment of one terminal, so echoed output reaches them all,
	// the way a real shared tmux session would.
	const attached = new Map<string, Set<WebSocket>>();
	// Output this terminal has already produced. The real agent replays the
	// same thing from tmux when a browser attaches (SPEC.md §9.1).
	const history = new Map<string, string[]>();
	const received: string[] = [];
	// The same frames, with the terminal each arrived on.
	const receivedByTerminal: { terminalId: string; text: string }[] = [];
	// The agent build each terminal's attach reports; a test stages an
	// upgrade for one terminal so parallel workers are not disturbed.
	const buildOf = new Map<string, string>();
	const projects = new Map<string, FakeDirectory>();
	const files = new Map<string, FakeNode>();
	const perKeyFiles = new Map<string, Map<string, FakeNode>>();
	// One fake agent stands in for every workspace in an end-to-end run, so a
	// token of the form "<token>:<key>" gets its own ~/projects listing and
	// workspaces do not discover each other's directories.
	const perKey = new Map<string, Map<string, FakeDirectory>>();

	// Git, search and events answers are seeded per workspace key and slug.
	const gitAnswers = new Map<string, FakeGitAnswer>();
	const searchAnswers = new Map<string, SearchMatch[]>();
	// Whether a seeded answer claims it was cut short, and the query string of
	// the last search asked for, so a browser test can check what it sent.
	const searchTruncated = new Map<string, boolean>();
	const lastSearches = new Map<string, { q: string; hidden: boolean }>();
	const eventSockets = new Map<string, Set<WebSocket>>();
	const watchFailures = new Set<string>();
	const eventCloses: Array<{ code: number; reason: string }> = [];

	const flags = {
		failCreateWith: null as string | null,
		openAttachments: 0,
		failLogLevel: false,
		searchAborted: 0,
		healthHits: 0,
		lastExitHits: 0,
		eventLimit: false,
		eventsReceived: 0,
		failForward: false,
		baselineReply: { baselineObjectId: null, baselineHead: null } as {
			baselineObjectId: string | null;
			baselineHead: string | null;
		},
		stopHold: null as { arrived: () => void; released: Promise<void> } | null,
	};

	// What each workspace key is listening on, who is watching it, and which
	// ports have a loopback forward open (BROWSER-HANDLING.md §11.1).
	const listening = new Map<string, AgentListeningService[]>();
	const listeningSockets = new Map<string, Set<WebSocket>>();
	const forwards = new Map<string, Set<number>>();
	const probes = new Map<string, number[]>();
	/** Test apps that serve HTTPS, which only a probe reveals. */
	const httpsApps = new Set<number>();
	const testApps: (Server | HttpsServer)[] = [];
	const appHits = new Map<number, number>();
	const logLevels: (string | null)[] = [];

	function projectNotFound(reply: FastifyReply) {
		return reply
			.status(404)
			.send({ error: { code: "PROJECT_NOT_FOUND", message: "no such project" } });
	}

	function authorized(request: FastifyRequest): boolean {
		const header = request.headers.authorization ?? "";
		return header === `Bearer ${token}` || header.startsWith(`Bearer ${token}:`);
	}

	/** The ~/projects listing for a key; the bare token keeps the shared one. */
	function dirsForKey(key: string): Map<string, FakeDirectory> {
		if (key === "") return projects;
		let dirs = perKey.get(key);
		if (!dirs) {
			dirs = new Map();
			perKey.set(key, dirs);
		}
		return dirs;
	}

	/** The map key one project's seeded answers live under. */
	function answerKey(key: string, slug: string): string {
		return `${key}/${slug}`;
	}

	/** The workspace key on the caller's bearer token; "" is the shared one. */
	function keyOf(request: FastifyRequest): string {
		const header = request.headers.authorization ?? "";
		const prefix = `Bearer ${token}:`;
		return header.startsWith(prefix) ? header.slice(prefix.length) : "";
	}

	/** The caller's ~/projects, from the suffix on its bearer token. */
	function dirs(request: FastifyRequest): Map<string, FakeDirectory> {
		return dirsForKey(keyOf(request));
	}

	/** The caller's filesystem, keyed the same way as its ~/projects listing. */
	function filesForKey(key: string): Map<string, FakeNode> {
		if (key === "") return files;
		let tree = perKeyFiles.get(key);
		if (!tree) {
			tree = new Map();
			perKeyFiles.set(key, tree);
		}
		return tree;
	}

	function fsOf(request: FastifyRequest): Map<string, FakeNode> {
		return filesForKey(keyOf(request));
	}

	// Workspace keys whose home folder is full: every write route fails with
	// STORAGE_FULL, as the real agent's does (SPEC.md §13.5).
	const diskFull = new Set<string>();
	// The terminals unit's exit record, per workspace key (SPEC.md §9.7). A
	// test stages a restart: the record is written and the terminals are gone.
	// With `live`, open panes first get `exit` the way a dying unit ends them,
	// and the record lands `recordDelayMs` later, as ExecStopPost writes it.
	const terminalsExit = new Map<string, { result: string; at: string }>();

	function fileError(reply: FastifyReply, error: FakeFileError) {
		if (error.etag) reply.header("etag", error.etag);
		return reply
			.status(FILE_ERROR_STATUS[error.code] ?? 500)
			.send({ error: { code: error.code, message: error.message } });
	}

	/** The node at a path, or a refusal that matches the agent's. */
	function nodeAt(
		request: FastifyRequest,
		slug: string,
		path: string,
	): FakeNode | undefined {
		if (!dirs(request).has(slug)) {
			throw new FakeFileError("PROJECT_NOT_FOUND", "no such project");
		}
		checkPath(path);
		if (path === "") return { type: "dir" };
		return fsOf(request).get(nodeKey(slug, path));
	}

	/** Refuse a path whose parent directory does not exist. */
	function requireParent(request: FastifyRequest, slug: string, path: string): void {
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent === "") return;
		if (fsOf(request).get(nodeKey(slug, parent))?.type !== "dir") {
			throw new FakeFileError("FILE_NOT_FOUND", "no such file or directory");
		}
	}

	/** Push one frame to every events subscriber of a project. */
	function pushEvent(key: string, slug: string, frame: unknown): number {
		const peers = eventSockets.get(answerKey(key, slug)) ?? new Set<WebSocket>();
		let sent = 0;
		for (const peer of peers) {
			if (peer.readyState !== peer.OPEN) continue;
			peer.send(JSON.stringify(frame));
			sent += 1;
			// Like the real agent, a project too large to watch is done.
			if ((frame as { type?: string } | null)?.type === "watch_limited") {
				peer.close(1000, "WATCH_LIMITED");
			}
		}
		return sent;
	}

	/** Push a frame past the control plane's 1 MiB cap on the agent socket. */
	function pushOversizedEvent(key: string, slug: string): number {
		const paths = ["x".repeat(1024 * 1024 + 1024)];
		return pushEvent(key, slug, { type: "fs", paths, git: false, truncated: false });
	}

	const SKIPPED_NAMES: ReadonlySet<string> = new Set(WATCH_SKIP_NAMES);
	/** Event sockets opened with hidden=1, which also hear generated folders. */
	const hiddenEventSockets = new WeakSet<WebSocket>();

	/**
	 * True for a path the real main watcher skips. The fake's hidden-files
	 * subscribers hear every depth, a little more than the real agent's
	 * narrow second watcher, which is enough for the browser tests.
	 */
	function insideSkipped(path: string): boolean {
		return path
			.split("/")
			.slice(0, -1)
			.some((segment) => segment !== ".git" && SKIPPED_NAMES.has(segment));
	}

	// Like the real watcher, a filesystem change becomes one coalesced
	// "fs" frame to every subscriber of that project (SPEC.md 11.4).
	const pendingFsPaths = new Map<string, Set<string>>();
	const pendingFsTimers = new Map<string, NodeJS.Timeout>();

	function noteFsChange(key: string, slug: string, paths: string[]): void {
		const id = answerKey(key, slug);
		const batch = pendingFsPaths.get(id) ?? new Set<string>();
		for (const path of paths) if (path) batch.add(path);
		pendingFsPaths.set(id, batch);
		if (pendingFsTimers.has(id)) return;
		const timer = setTimeout(() => {
			pendingFsTimers.delete(id);
			const flushed = pendingFsPaths.get(id) ?? new Set<string>();
			pendingFsPaths.delete(id);
			const all = [...flushed];
			const visible = all.filter((path) => !insideSkipped(path));
			for (const peer of eventSockets.get(id) ?? []) {
				if (peer.readyState !== peer.OPEN) continue;
				const paths = hiddenEventSockets.has(peer) ? all : visible;
				if (paths.length === 0) continue;
				peer.send(JSON.stringify({ type: "fs", paths, git: false, truncated: false }));
			}
		}, 50);
		timer.unref?.();
		pendingFsTimers.set(id, timer);
	}

	const recoveryPoints = new Map<string, FakeRecoveryPoint>();
	const recoveryDeletes: string[] = [];
	const recoveryFull = new Set<string>();
	const restoreIncomplete = new Set<string>();
	const restoreFailure = new Map<string, [number, string]>();
	const storage = new Map<string, FakeStorage>();
	const processes = new Map<string, FakeProcess[]>();
	const memory = new Map<string, { usedBytes: number; totalBytes: number }>();
	function processesFor(key: string): FakeProcess[] {
		let list = processes.get(key);
		if (!list) {
			list = defaultProcesses();
			processes.set(key, list);
		}
		return list;
	}

	// The reinstall note by workspace key (ADR 0042); empty until a test seeds one.
	const reinstallNotes = new Map<string, string[]>();

	return {
		token,
		flags,
		terminals,
		creates,
		requests,
		attached,
		history,
		received,
		receivedByTerminal,
		buildOf,
		projects,
		files,
		gitAnswers,
		searchAnswers,
		searchTruncated,
		lastSearches,
		eventSockets,
		hiddenEventSockets,
		watchFailures,
		eventCloses,
		pendingFsPaths,
		pendingFsTimers,
		listening,
		listeningSockets,
		forwards,
		probes,
		httpsApps,
		testApps,
		appHits,
		logLevels,
		diskFull,
		terminalsExit,
		recoveryPoints,
		recoveryDeletes,
		recoveryFull,
		restoreIncomplete,
		restoreFailure,
		storage,
		processes,
		memory,
		reinstallNotes,
		projectNotFound,
		authorized,
		dirsForKey,
		answerKey,
		keyOf,
		dirs,
		filesForKey,
		fsOf,
		fileError,
		nodeAt,
		requireParent,
		pushEvent,
		pushOversizedEvent,
		noteFsChange,
		processesFor,
	};
}

export type FakeAgentState = ReturnType<typeof createFakeAgentState>;
