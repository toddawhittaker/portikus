import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import {
	type AgentListeningService,
	type AgentLogLine,
	MAX_UPLOAD_BYTES,
	type SearchMatch,
} from "@portikus/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCheckRoutes } from "./checks.js";
import { registerEventRoutes } from "./events.js";
import { registerFileRoutes } from "./files.js";
import type { FakeDirectory, FakeNode } from "./fs-model.js";
import { registerGitRoutes } from "./git.js";
import { registerListeningRoutes } from "./listening.js";
import { registerPackageRoutes } from "./packages.js";
import { registerProcessRoutes } from "./processes.js";
import { registerProjectRoutes } from "./projects.js";
import { registerRecoveryRoutes } from "./recovery.js";
import { registerSearchRoutes } from "./search.js";
import {
	createFakeAgentState,
	type FakeGitAnswer,
	type FakeProcess,
	type FakeRecoveryPoint,
	type FakeStorage,
} from "./state.js";
import { registerTerminalRoutes } from "./terminals.js";
import { registerUsageRoutes } from "./usage.js";

export { oneFileZip } from "./fs-model.js";

/** What the fake's `GET /log` answers: two lines a real ring could hold. */
export const FAKE_AGENT_LOG: AgentLogLine[] = [
	{
		time: "2026-10-10T09:00:00.000Z",
		level: "warn",
		msg: "could not tidy the coding-agent instructions files",
	},
	{
		time: "2026-10-10T09:05:00.000Z",
		level: "error",
		msg: "request failed",
		code: "INTERNAL",
		status: 500,
		durationMs: 12,
	},
];

/**
 * A stand-in for the workspace agent, used by the API tests. It checks the
 * bearer token, keeps terminals in memory, and echoes attach input back.
 */
export interface FakeAgent {
	port: number;
	token: string;
	/** How many HTTP requests each test application has answered, by port. */
	appHits: Map<number, number>;
	terminals: Map<
		string,
		{
			cwd: string;
			theme: string;
			timezone: string;
			agent?: string;
			institutionalEnv?: Record<string, string>;
		}
	>;
	/**
	 * Every request the agent routes received, token or not, in order. The
	 * /__test hooks are left out, since the agent proper never sees them.
	 */
	readonly requests: Array<{ method: string; url: string }>;
	/** Bodies of POST /terminals, in order, so a test can see what was forwarded. */
	readonly creates: Array<Record<string, unknown>>;
	/** What the next create answers for the review baseline (SPEC.md §10.9). */
	baselineReply: { baselineObjectId: string | null; baselineHead: string | null };
	/** Frames the fake received on an attach socket, in order. */
	received: string[];
	/** Attach sockets currently open on the fake. */
	readonly openAttachments: number;
	/** Make the next create call fail with this agent error code. */
	failCreateWith: string | null;
	/** Log levels pushed to `PUT /log-level`, in order. */
	readonly logLevels: (string | null)[];
	/** While true, `PUT /log-level` fails so a retry can be observed. */
	failLogLevel: boolean;
	/** Project directories the fake pretends to have under ~/projects. */
	projects: Map<string, FakeDirectory>;
	/** Everything under those directories, keyed the same way as the listings. */
	files: Map<string, FakeNode>;
	/** Seeded Git answers, keyed by `<workspace key>/<slug>`. */
	git: Map<string, FakeGitAnswer>;
	/** Seeded search matches, keyed the same way. */
	search: Map<string, SearchMatch[]>;
	/** Searches the fake saw cancelled by the caller hanging up. */
	readonly searchAborted: number;
	/** How many `GET /health` calls the fake answered. */
	readonly healthHits: number;
	/** How many `GET /terminals/last-exit` calls the fake answered. */
	readonly lastExitHits: number;
	/** While true, the next events socket is refused as over the cap. */
	eventLimit: boolean;
	/** Projects whose watcher fails, keyed like the Git answers. */
	watchFailures: Set<string>;
	/** Frames the fake received on its events sockets, which must stay zero. */
	readonly eventsReceived: number;
	/** How each events socket was closed by the caller, in order. */
	eventCloses: Array<{ code: number; reason: string }>;
	/** What each workspace key is listening on, keyed by agent-token suffix. */
	listening: Map<string, AgentListeningService[]>;
	/** Ports with a loopback forward open, keyed the same way. */
	forwards: Map<string, Set<number>>;
	/** Ports the fake was asked to TLS-probe, in order, keyed the same way. */
	probes: Map<string, number[]>;
	/** While true, `POST /forwards` fails so the grant route's 409 shows. */
	failForward: boolean;
	/**
	 * Hold the next listener or process stop until `release` is called; `reached`
	 * resolves once that stop has arrived at the fake.
	 */
	holdNextStop: () => { reached: Promise<void>; release: () => void };
	/** The same for the next recovery-point diff. */
	holdNextDiff: () => { reached: Promise<void>; release: () => void };
	/** Archives the fake holds in memory, by point id (ADR 0020). */
	recoveryPoints: Map<string, FakeRecoveryPoint>;
	/** Project ids whose archives `DELETE /recovery-points/:projectId` removed. */
	readonly recoveryDeletes: string[];
	/** Workspace keys whose next recovery point fails with STORAGE_FULL. */
	recoveryFull: Set<string>;
	/** Workspace keys whose restores fail as RESTORE_INCOMPLETE. */
	restoreIncomplete: Set<string>;
	/** Workspace keys whose restores fail with this status and code. */
	restoreFailure: Map<string, [number, string]>;
	/** Workspace keys whose recovery-point diffs fail with this status and code. */
	diffFailure: Map<string, [number, string]>;
	/** Storage figures `/usage` reports, by workspace key; absent means null. */
	storage: Map<string, FakeStorage>;
	/** Processes `/usage` reports and `/processes/:pid/stop` stops, by workspace key. */
	processes: Map<string, FakeProcess[]>;
	/** Push one frame to every events subscriber of a project. */
	pushEvent: (key: string, slug: string, frame: unknown) => number;
	/** Push one frame larger than the control plane's 1 MiB cap. */
	pushOversizedEvent: (key: string, slug: string) => number;
	close: () => Promise<void>;
}

/** A gate a fake route waits on, and the test's side of it. */
function newHold() {
	let arrived = () => {};
	let release = () => {};
	const reached = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { hold: { arrived, released }, handle: { reached, release } };
}

export async function startFakeAgent(
	token: string,
	options: { port?: number } = {},
): Promise<FakeAgent> {
	const s = createFakeAgentState(token);
	const {
		flags,
		terminals,
		creates,
		requests,
		received,
		projects,
		files,
		gitAnswers,
		searchAnswers,
		watchFailures,
		eventCloses,
		pendingFsPaths,
		pendingFsTimers,
		listening,
		forwards,
		probes,
		testApps,
		appHits,
		logLevels,
		diskFull,
		recoveryPoints,
		recoveryDeletes,
		recoveryFull,
		restoreIncomplete,
		restoreFailure,
		diffFailure,
		storage,
		processes,
		authorized,
		keyOf,
		pushEvent,
		pushOversizedEvent,
	} = s;
	const app: FastifyInstance = Fastify({ logger: false, bodyLimit: MAX_UPLOAD_BYTES });
	await app.register(websocket);

	// A file write carries a raw body of any type, so keep it as bytes. JSON
	// still goes to Fastify's own parser, which this does not replace. Like the
	// real agent, a body past the upload cap tears the request down mid-stream
	// rather than being buffered to the end (SPEC.md 11.2).
	app.addContentTypeParser("*", (request, payload, done) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let stopped = false;
		payload.on("data", (chunk: Buffer) => {
			if (stopped) return;
			total += chunk.length;
			if (total > MAX_UPLOAD_BYTES) {
				stopped = true;
				request.raw.destroy();
				return;
			}
			chunks.push(chunk);
		});
		payload.on("end", () => {
			if (!stopped) done(null, Buffer.concat(chunks));
		});
		payload.on("error", (error: Error) => {
			if (!stopped) done(error);
		});
	});

	app.addHook("onRequest", async (request, reply) => {
		// The /__test hooks exist only on the fake and need no token, so an
		// end-to-end test can seed a directory the way a student would.
		if (request.url.startsWith("/__test/")) return;
		requests.push({ method: request.method, url: request.url });
		if (!authorized(request)) {
			return reply
				.status(401)
				.send({ error: { code: "UNAUTHORIZED", message: "bad token" } });
		}
	});

	// Workspace keys whose home folder is full: every write route fails with
	// STORAGE_FULL, as the real agent's does (SPEC.md §13.5).
	const WRITE_ROUTES = new Set([
		"PUT /projects/:slug/file",
		"POST /projects/:slug/mkdir",
		"POST /projects/:slug/move",
		"POST /projects/:slug/extract",
		"POST /projects",
	]);
	app.addHook("onRequest", async (request, reply) => {
		if (!diskFull.has(keyOf(request))) return;
		if (!WRITE_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return;
		return reply.status(507).send({
			error: { code: "STORAGE_FULL", message: "no space left in the home folder" },
		});
	});
	app.post("/__test/disk-full", async (request, reply) => {
		const body = request.body as { key?: string; full: boolean };
		if (body.full) diskFull.add(body.key ?? "");
		else diskFull.delete(body.key ?? "");
		return reply.status(204).send();
	});

	app.get("/health", async () => {
		flags.healthHits += 1;
		return { ok: true };
	});

	app.put("/log-level", async (request, reply) => {
		if (flags.failLogLevel) {
			return reply
				.status(500)
				.send({ error: { code: "INTERNAL", message: "log level refused" } });
		}
		logLevels.push((request.body as { level: string | null }).level);
		return reply.status(204).send();
	});

	app.get("/log", async () => ({ lines: FAKE_AGENT_LOG }));

	registerTerminalRoutes(app, s);
	registerProjectRoutes(app, s);
	registerFileRoutes(app, s);
	registerGitRoutes(app, s);
	registerSearchRoutes(app, s);
	registerEventRoutes(app, s);
	registerCheckRoutes(app, s);
	registerRecoveryRoutes(app, s);
	registerUsageRoutes(app, s);
	registerPackageRoutes(app, s);
	registerProcessRoutes(app, s);
	registerListeningRoutes(app, s);

	await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;

	return {
		port: address.port,
		token,
		appHits,
		holdNextStop() {
			const { hold, handle } = newHold();
			flags.stopHold = hold;
			return handle;
		},
		holdNextDiff() {
			const { hold, handle } = newHold();
			flags.diffHold = hold;
			return handle;
		},
		terminals,
		creates,
		requests,
		get baselineReply() {
			return flags.baselineReply;
		},
		set baselineReply(value) {
			flags.baselineReply = value;
		},
		received,
		projects,
		files,
		git: gitAnswers,
		search: searchAnswers,
		watchFailures,
		eventCloses,
		pushEvent,
		pushOversizedEvent,
		logLevels,
		get searchAborted() {
			return flags.searchAborted;
		},
		get healthHits() {
			return flags.healthHits;
		},
		get lastExitHits() {
			return flags.lastExitHits;
		},
		get eventsReceived() {
			return flags.eventsReceived;
		},
		get eventLimit() {
			return flags.eventLimit;
		},
		set eventLimit(value: boolean) {
			flags.eventLimit = value;
		},
		get failLogLevel() {
			return flags.failLogLevel;
		},
		set failLogLevel(value: boolean) {
			flags.failLogLevel = value;
		},
		get openAttachments() {
			return flags.openAttachments;
		},
		get failCreateWith() {
			return flags.failCreateWith;
		},
		set failCreateWith(code: string | null) {
			flags.failCreateWith = code;
		},
		listening,
		forwards,
		probes,
		recoveryPoints,
		recoveryDeletes,
		recoveryFull,
		restoreIncomplete,
		restoreFailure,
		diffFailure,
		storage,
		processes,
		get failForward() {
			return flags.failForward;
		},
		set failForward(value: boolean) {
			flags.failForward = value;
		},
		close: async () => {
			for (const server of testApps) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			for (const timer of pendingFsTimers.values()) clearTimeout(timer);
			pendingFsTimers.clear();
			pendingFsPaths.clear();
			await app.close();
		},
	};
}
