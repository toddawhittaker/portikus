import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import websocket, { type WebSocket } from "@fastify/websocket";
import {
	type AgentListeningService,
	CHECKS_FILE_PATH,
	type CheckDefinition,
	type CheckRun,
	ChecksFile,
	type GitDiff,
	type GitStatus,
	GitStatusQuery,
	MAX_EDITOR_FILE_BYTES,
	MAX_UPLOAD_BYTES,
	ProjectPath,
	type SearchMatch,
	SearchQuery,
} from "@portikus/contracts";
import Fastify, {
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
} from "fastify";
import { WebSocketServer } from "ws";

/**
 * A stand-in for the workspace agent, used by the API tests. It checks the
 * bearer token, keeps terminals in memory, and echoes attach input back.
 */
export interface FakeAgent {
	port: number;
	token: string;
	terminals: Map<string, { cwd: string }>;
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
	/** While true, `POST /forwards` fails so the grant route's 409 shows. */
	failForward: boolean;
	/** Push one frame to every events subscriber of a project. */
	pushEvent: (key: string, slug: string, frame: unknown) => number;
	/** Push one frame larger than the control plane's 1 MiB cap. */
	pushOversizedEvent: (key: string, slug: string) => number;
	close: () => Promise<void>;
}

/** What the fake answers the Git routes of one project with. */
export interface FakeGitAnswer {
	status?: GitStatus;
	diffs?: Record<string, GitDiff>;
}

/** One entry of the fake filesystem. Paths are `<slug>/<path inside it>`. */
export type FakeNode = { type: "file"; content: Buffer } | { type: "dir" };

/** CRC-32 of a buffer, which a zip entry header must carry. */
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A valid zip holding one stored (uncompressed) file, written by hand so the
 * fake agent needs no zip dependency.
 */
export function oneFileZip(name: string, contents: string): Buffer {
	const nameBytes = Buffer.from(name, "utf8");
	const data = Buffer.from(contents, "utf8");
	const sum = crc32(data);

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0, 6); // flags
	local.writeUInt16LE(0, 8); // stored
	local.writeUInt16LE(0, 10); // time
	local.writeUInt16LE(0, 12); // date
	local.writeUInt32LE(sum, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	local.writeUInt16LE(0, 28); // extra length

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4); // version made by
	central.writeUInt16LE(20, 6); // version needed
	central.writeUInt16LE(0, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt16LE(0, 12);
	central.writeUInt16LE(0, 14);
	central.writeUInt32LE(sum, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	central.writeUInt16LE(0, 30); // extra
	central.writeUInt16LE(0, 32); // comment
	central.writeUInt16LE(0, 34); // disk
	central.writeUInt16LE(0, 36); // internal attributes
	central.writeUInt32LE(0, 38); // external attributes
	central.writeUInt32LE(0, 42); // offset of local header

	const centralSize = central.length + nameBytes.length;
	const centralOffset = local.length + nameBytes.length + data.length;

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

/** The status the real agent answers each file error with (its ERROR_STATUS). */
const FILE_ERROR_STATUS: Record<string, number> = {
	BAD_REQUEST: 400,
	PATH_INVALID: 400,
	NOT_A_DIRECTORY: 400,
	PROJECT_NOT_FOUND: 404,
	FILE_NOT_FOUND: 404,
	FILE_EXISTS: 409,
	FILE_CHANGED: 412,
	FILE_TOO_LARGE: 413,
};

/** A file operation the fake refuses, mirroring the agent's AgentFailure. */
class FakeFileError extends Error {
	readonly code: string;
	readonly etag: string | undefined;

	constructor(code: string, message: string, etag?: string) {
		super(message);
		this.code = code;
		this.etag = etag;
	}
}

function etagOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** The same sniff the real agent does: a NUL byte early on means binary. */
function contentTypeOf(content: Buffer): string {
	return content.subarray(0, 8 * 1024).includes(0)
		? "application/octet-stream"
		: "text/plain; charset=utf-8";
}

/** The map key of a path inside a project; the empty path is the project. */
function nodeKey(slug: string, path: string): string {
	return path === "" ? slug : `${slug}/${path}`;
}

function checkPath(path: string): void {
	if (path !== "" && !ProjectPath.safeParse(path).success) {
		throw new FakeFileError("PATH_INVALID", "invalid path");
	}
}

/** Mark every parent directory of a path as existing, the way mkdir -p does. */
function addParents(tree: Map<string, FakeNode>, slug: string, path: string): void {
	const parts = path.split("/").slice(0, -1);
	let walked = "";
	for (const part of parts) {
		walked = walked === "" ? part : `${walked}/${part}`;
		tree.set(nodeKey(slug, walked), { type: "dir" });
	}
}

/** Drop a project directory and everything under it. */
function removeTree(tree: Map<string, FakeNode>, slug: string): void {
	for (const key of [...tree.keys()]) {
		if (key === slug || key.startsWith(`${slug}/`)) tree.delete(key);
	}
}

/** Move (or copy) a project's whole subtree onto a new slug. */
/**
 * One directory under `~/projects` as the fake holds it. `directoryId` stands
 * in for the inode the real agent reports (issue #238): a rename keeps the
 * same record, so the identity travels with the directory.
 */
interface FakeDirectory {
	isGitRepo: boolean;
	/** Absent when a test seeded the map directly and does not care. */
	directoryId?: string;
}

let directoryIdCounter = 1000;
function nextDirectoryId(): string {
	directoryIdCounter += 1;
	return String(directoryIdCounter);
}

function rekeyTree(
	tree: Map<string, FakeNode>,
	from: string,
	to: string,
	options: { copy: boolean },
): void {
	for (const [key, value] of [...tree]) {
		if (key !== from && !key.startsWith(`${from}/`)) continue;
		const moved: FakeNode =
			value.type === "file"
				? { type: "file", content: Buffer.from(value.content) }
				: { type: "dir" };
		tree.set(`${to}${key.slice(from.length)}`, moved);
		if (!options.copy) tree.delete(key);
	}
}

export async function startFakeAgent(
	token: string,
	options: { port?: number } = {},
): Promise<FakeAgent> {
	const terminals = new Map<string, { cwd: string }>();
	// Every attachment of one terminal, so echoed output reaches them all,
	// the way a real shared tmux session would.
	const attached = new Map<string, Set<WebSocket>>();
	// Output this terminal has already produced. The real agent replays the
	// same thing from tmux when a browser attaches (SPEC.md §9.1).
	const history = new Map<string, string[]>();
	const received: string[] = [];
	// The same frames, with the terminal each arrived on.
	const receivedByTerminal: { terminalId: string; text: string }[] = [];
	const projects = new Map<string, FakeDirectory>();
	const files = new Map<string, FakeNode>();
	const perKeyFiles = new Map<string, Map<string, FakeNode>>();
	// One fake agent stands in for every workspace in an end-to-end run, so a
	// token of the form "<token>:<key>" gets its own ~/projects listing and
	// workspaces do not discover each other's directories.
	const perKey = new Map<string, Map<string, FakeDirectory>>();
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

	const state = {
		failCreateWith: null as string | null,
		openAttachments: 0,
		failLogLevel: false,
		searchAborted: 0,
		eventLimit: false,
		eventsReceived: 0,
		failForward: false,
	};

	// What each workspace key is listening on, who is watching it, and which
	// ports have a loopback forward open (BROWSER-HANDLING.md §11.1).
	const listening = new Map<string, AgentListeningService[]>();
	const listeningSockets = new Map<string, Set<WebSocket>>();
	const forwards = new Map<string, Set<number>>();
	const testApps: Server[] = [];

	function listeningFor(key: string): AgentListeningService[] {
		return listening.get(key) ?? [];
	}

	function sendListening(socket: WebSocket, services: AgentListeningService[]): void {
		if (socket.readyState !== socket.OPEN) return;
		socket.send(
			JSON.stringify({
				type: "workspace.listening-services.changed",
				services,
				observedAt: new Date().toISOString(),
			}),
		);
	}

	function pushListening(key: string): void {
		for (const socket of listeningSockets.get(key) ?? []) {
			sendListening(socket, listeningFor(key));
		}
	}

	/** Mirror the real agent: an open forward makes a loopback port reachable. */
	function markForwarded(key: string, port: number, open: boolean): void {
		listening.set(
			key,
			listeningFor(key).map((service) =>
				service.port === port
					? { ...service, previewReachability: open ? "forwarded" : "unknown" }
					: service,
			),
		);
		pushListening(key);
	}

	/** A real HTTP and WebSocket application, on a port of its own. */
	async function startTestApp(title: string): Promise<number> {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
		});
		const sockets = new WebSocketServer({ server });
		sockets.on("connection", (socket) => {
			socket.on("message", (data: Buffer) => socket.send(`echo:${data.toString()}`));
			socket.send("hello");
		});
		testApps.push(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		return (server.address() as AddressInfo).port;
	}
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

	app.addHook("onRequest", async (request, reply) => {
		// The /__test hooks exist only on the fake and need no token, so an
		// end-to-end test can seed a directory the way a student would.
		if (request.url.startsWith("/__test/")) return;
		if (!authorized(request)) {
			return reply
				.status(401)
				.send({ error: { code: "UNAUTHORIZED", message: "bad token" } });
		}
	});

	app.get("/health", async () => ({ ok: true }));

	app.put("/log-level", async (request, reply) => {
		if (state.failLogLevel) {
			return reply
				.status(500)
				.send({ error: { code: "INTERNAL", message: "log level refused" } });
		}
		logLevels.push((request.body as { level: string | null }).level);
		return reply.status(204).send();
	});

	app.get("/terminals", async () => ({
		terminals: [...terminals].map(([id, value]) => ({
			id,
			cwd: value.cwd,
			attachments: 0,
		})),
	}));

	app.post("/terminals", async (request, reply) => {
		if (state.failCreateWith) {
			const code = state.failCreateWith;
			state.failCreateWith = null;
			return reply
				.status(code === "INVALID_CWD" ? 400 : 500)
				.send({ error: { code, message: "create refused" } });
		}
		const body = request.body as { id: string; cwd: string };
		terminals.set(body.id, { cwd: body.cwd });
		return reply.status(201).send({ ok: true });
	});

	app.delete("/terminals/:id", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		if (!terminals.delete(id)) {
			return reply
				.status(404)
				.send({ error: { code: "TERMINAL_NOT_FOUND", message: "no such terminal" } });
		}
		return reply.status(204).send();
	});

	app.get("/projects", async (request) => ({
		projects: [...dirs(request)].map(([slug, value]) => ({
			directoryId: value.directoryId,
			slug,
			isGitRepo: value.isGitRepo,
		})),
	}));

	app.get("/projects/:slug", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const project = dirs(request).get(slug);
		if (!project) return projectNotFound(reply);
		return {
			slug,
			isGitRepo: project.isGitRepo,
			directoryId: project.directoryId,
		};
	});

	app.post("/projects", async (request, reply) => {
		const body = request.body as {
			slug: string;
			source: "new" | "clone" | "template";
			url?: string;
			gitInit: boolean;
		};
		const here = dirs(request);
		if (here.has(body.slug)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		// A url the test marks as failing stands in for a clone that goes wrong.
		if (body.source !== "new" && (body.url ?? "").includes("fail")) {
			return reply
				.status(400)
				.send({ error: { code: "GIT_FAILED", message: "clone failed" } });
		}
		// A url the test marks as slow stands in for a clone that takes a while.
		if ((body.url ?? "").includes("slow")) {
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const isGitRepo = body.source === "new" ? body.gitInit : true;
		here.set(body.slug, { isGitRepo, directoryId: nextDirectoryId() });
		return reply.status(201).send({ slug: body.slug, isGitRepo });
	});

	app.delete("/projects/:slug", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).delete(slug)) return projectNotFound(reply);
		removeTree(fsOf(request), slug);
		return reply.status(204).send();
	});

	app.post("/projects/:slug/rename", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const here = dirs(request);
		const project = here.get(slug);
		if (!project) return projectNotFound(reply);
		if (here.has(to)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		here.delete(slug);
		here.set(to, project);
		rekeyTree(fsOf(request), slug, to, { copy: false });
		return reply.status(204).send();
	});

	app.post("/projects/:slug/duplicate", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const here = dirs(request);
		const project = here.get(slug);
		if (!project) return projectNotFound(reply);
		if (here.has(to)) {
			return reply
				.status(409)
				.send({ error: { code: "PROJECT_EXISTS", message: "already exists" } });
		}
		here.set(to, { isGitRepo: project.isGitRepo, directoryId: nextDirectoryId() });
		rekeyTree(fsOf(request), slug, to, { copy: true });
		return reply.status(201).send({ slug: to, isGitRepo: project.isGitRepo });
	});

	app.post("/projects/:slug/git-init", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const project = dirs(request).get(slug);
		if (!project) return projectNotFound(reply);
		project.isGitRepo = true;
		return reply.status(204).send();
	});

	app.get("/projects/:slug/archive", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const path = (request.query as { path?: string }).path ?? "";
		if (path !== "" && fsOf(request).get(nodeKey(slug, path))?.type !== "dir") {
			return fileError(reply, new FakeFileError("FILE_NOT_FOUND", "no such directory"));
		}
		const name = path === "" ? slug : path.split("/").slice(-1)[0];
		return reply
			.header("content-type", "application/zip")
			.send(oneFileZip(`${name}/README.md`, `# ${name}\n`));
	});

	// The file routes, with the same status codes, etags and conditional
	// write rules as the real agent (SPEC.md §11.1, §11.2, §13.5).

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

	app.get("/projects/:slug/tree", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.query as { path?: string }).path ?? "";
		try {
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such directory");
			if (node.type !== "dir") {
				throw new FakeFileError("NOT_A_DIRECTORY", "not a directory");
			}
			const prefix = path === "" ? `${slug}/` : `${slug}/${path}/`;
			const entries = [...fsOf(request)]
				.filter(([key]) => key.startsWith(prefix))
				.filter(([key]) => !key.slice(prefix.length).includes("/"))
				.map(([key, value]) => ({
					name: key.slice(prefix.length),
					type: value.type,
					size: value.type === "file" ? value.content.length : 0,
					mtimeMs: 0,
				}));
			entries.sort((a, b) => {
				const aDir = a.type === "dir" ? 0 : 1;
				const bDir = b.type === "dir" ? 0 : 1;
				if (aDir !== bDir) return aDir - bDir;
				return a.name.localeCompare(b.name);
			});
			return { entries, truncated: false };
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.get("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const query = request.query as { path?: string; download?: string };
		const path = query.path ?? "";
		try {
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			if (node.type !== "file") {
				throw new FakeFileError("BAD_REQUEST", "that path is a directory");
			}
			if (query.download !== "1" && node.content.length > MAX_EDITOR_FILE_BYTES) {
				throw new FakeFileError(
					"FILE_TOO_LARGE",
					"that file is too large to open here",
				);
			}
			return reply
				.header("etag", etagOf(node.content))
				.header("content-length", String(node.content.length))
				.type(contentTypeOf(node.content))
				.send(node.content);
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.put("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.query as { path?: string }).path ?? "";
		const ifMatch = request.headers["if-match"];
		// Only the literal "*" is a condition, exactly as the real agent reads it.
		const ifNoneMatch = request.headers["if-none-match"] === "*";
		// Fastify parses text/plain itself, so a text write arrives as a string.
		const raw = request.body;
		const body = Buffer.isBuffer(raw)
			? raw
			: Buffer.from(typeof raw === "string" ? raw : "", "utf8");
		try {
			const conditions = (typeof ifMatch === "string" ? 1 : 0) + (ifNoneMatch ? 1 : 0);
			if (conditions !== 1) {
				throw new FakeFileError(
					"BAD_REQUEST",
					"a write needs exactly one of If-Match or If-None-Match",
				);
			}
			const node = nodeAt(request, slug, path);
			if (path === "") throw new FakeFileError("PATH_INVALID", "invalid path");
			if (ifNoneMatch) {
				if (node) throw new FakeFileError("FILE_EXISTS", "that file already exists");
			} else {
				if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
				if (node.type !== "file") {
					throw new FakeFileError("BAD_REQUEST", "that path is a directory");
				}
				const current = etagOf(node.content);
				const asked = String(ifMatch).replace(/^W\//, "").replace(/^"|"$/g, "");
				// "*" is the HTTP wildcard: any existing file will do.
				if (asked !== "*" && current !== asked) {
					throw new FakeFileError(
						"FILE_CHANGED",
						"the file changed on disk since it was read",
						current,
					);
				}
			}
			requireParent(request, slug, path);
			const contentType = request.headers["content-type"] ?? "";
			const limit = contentType.startsWith("application/octet-stream")
				? MAX_UPLOAD_BYTES
				: MAX_EDITOR_FILE_BYTES;
			if (body.length > limit) {
				throw new FakeFileError("FILE_TOO_LARGE", "that file is too large");
			}
			fsOf(request).set(nodeKey(slug, path), { type: "file", content: body });
			noteFsChange(keyOf(request), slug, [path]);
			const etag = etagOf(body);
			return reply.header("etag", etag).status(200).send({ etag, size: body.length });
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.delete("/projects/:slug/file", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.query as { path?: string }).path ?? "";
		try {
			if (path === "") {
				throw new FakeFileError(
					"PATH_INVALID",
					"the project itself cannot be deleted here",
				);
			}
			const node = nodeAt(request, slug, path);
			if (!node) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			const tree = fsOf(request);
			tree.delete(nodeKey(slug, path));
			if (node.type === "dir") {
				const prefix = `${slug}/${path}/`;
				for (const key of [...tree.keys()]) {
					if (key.startsWith(prefix)) tree.delete(key);
				}
			}
			noteFsChange(keyOf(request), slug, [path]);
			return reply.status(204).send();
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.post("/projects/:slug/mkdir", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const path = (request.body as { path?: string }).path ?? "";
		try {
			if (nodeAt(request, slug, path)) {
				throw new FakeFileError("FILE_EXISTS", "that name is already taken");
			}
			requireParent(request, slug, path);
			fsOf(request).set(nodeKey(slug, path), { type: "dir" });
			noteFsChange(keyOf(request), slug, [path]);
			return reply.status(201).send({ ok: true });
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	app.post("/projects/:slug/move", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const body = request.body as { from?: string; to?: string };
		const from = body.from ?? "";
		const to = body.to ?? "";
		try {
			const source = nodeAt(request, slug, from);
			if (!source) throw new FakeFileError("FILE_NOT_FOUND", "no such file");
			if (nodeAt(request, slug, to)) {
				throw new FakeFileError("FILE_EXISTS", "that name is already taken");
			}
			requireParent(request, slug, to);
			const tree = fsOf(request);
			tree.delete(nodeKey(slug, from));
			tree.set(nodeKey(slug, to), source);
			// Everything under a directory moves with it.
			const prefix = `${slug}/${from}/`;
			for (const [key, value] of [...tree]) {
				if (!key.startsWith(prefix)) continue;
				tree.delete(key);
				tree.set(`${slug}/${to}/${key.slice(prefix.length)}`, value);
			}
			noteFsChange(keyOf(request), slug, [from, to]);
			return reply.status(204).send();
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
	});

	// The read-only Git, search and events routes, with the same status and
	// close codes as the real agent (SPEC.md §11.4, §11.5, §12.1, §12.6).

	/** An empty repository answer, so an unseeded project still reads. */
	function emptyStatus(): GitStatus {
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
	 * A slug the test marks as slow stands in for a git command that takes
	 * most of the agent's own per-command budget, so the control plane's wait
	 * can be observed.
	 */
	const SLOW_GIT_MS = 6000;
	async function slowIfMarked(slug: string): Promise<void> {
		if (!slug.includes("slow")) return;
		await new Promise((resolve) => setTimeout(resolve, SLOW_GIT_MS));
	}

	app.get("/projects/:slug/git/status", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		await slowIfMarked(slug);
		const query = GitStatusQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid hidden flag"));
		}
		const status = gitAnswers.get(answerKey(keyOf(request), slug))?.status;
		if (!status) return emptyStatus();
		// Ignored paths are only sent when hidden files are shown.
		return query.data.hidden ? status : { ...status, ignored: [] };
	});

	app.get("/projects/:slug/git/diff", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		await slowIfMarked(slug);
		const path = (request.query as { path?: string }).path ?? "";
		if (!ProjectPath.safeParse(path).success) {
			return fileError(reply, new FakeFileError("PATH_INVALID", "invalid path"));
		}
		const diff = gitAnswers.get(answerKey(keyOf(request), slug))?.diffs?.[path];
		if (!diff) {
			return fileError(reply, new FakeFileError("FILE_NOT_FOUND", "no such file"));
		}
		return diff;
	});

	app.get("/projects/:slug/search", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const query = SearchQuery.safeParse(request.query ?? {});
		if (!query.success) {
			return fileError(reply, new FakeFileError("BAD_REQUEST", "invalid search query"));
		}
		// A query the test marks as slow stands in for a search still running
		// when the browser gives up, so cancellation can be observed.
		if (query.data.q.includes("slow")) {
			await new Promise<void>((resolve) => {
				const onClose = () => {
					state.searchAborted += 1;
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					// The caller waited it out, so this search was not cancelled.
					request.raw.off("close", onClose);
					resolve();
				}, 5000);
				request.raw.on("close", onClose);
			});
			if (request.raw.destroyed) {
				// Nobody is listening any more, so send nothing at all.
				reply.hijack();
				return;
			}
		}
		const key = answerKey(keyOf(request), slug);
		lastSearches.set(key, { q: query.data.q, hidden: query.data.hidden });
		const matches = searchAnswers.get(key) ?? [];
		return { matches, truncated: searchTruncated.get(key) ?? false };
	});

	// Project checks (SPEC.md §18.1). The definitions come from the fake
	// filesystem, so a browser test seeds `.portikus/checks.json` the way a
	// student would. A "run" prints its command and ends with 0 or 1; a
	// command containing "sleep" stays running until it is stopped.
	interface FakeCheckRun {
		meta: CheckRun;
		lines: string[];
		sockets: Set<WebSocket>;
		final: { type: "exit"; exitCode: number } | null;
	}
	const checkRuns = new Map<string, FakeCheckRun>();
	let checkRunCounter = 0;

	function checkRunKey(request: FastifyRequest, slug: string, id: string): string {
		return `${keyOf(request)}\u0000${slug}\u0000${id}`;
	}

	/** The definitions of one project, with the same reporting as the agent. */
	function readFakeChecks(
		request: FastifyRequest,
		slug: string,
	): { checks: CheckDefinition[]; error: string | null } {
		const node = nodeAt(request, slug, CHECKS_FILE_PATH);
		if (node?.type !== "file") return { checks: [], error: null };
		let parsed: unknown;
		try {
			parsed = JSON.parse(node.content.toString("utf8"));
		} catch {
			return { checks: [], error: `${CHECKS_FILE_PATH} is not valid JSON.` };
		}
		const validated = ChecksFile.safeParse(parsed);
		if (!validated.success) {
			return {
				checks: [],
				error: `${CHECKS_FILE_PATH} does not look like a list of checks.`,
			};
		}
		return { checks: validated.data.checks, error: null };
	}

	function finishFakeRun(run: FakeCheckRun, exitCode: number): void {
		run.meta.state = exitCode === 0 ? "passed" : "failed";
		run.meta.exitCode = exitCode;
		run.meta.endedAt = new Date().toISOString();
		run.final = { type: "exit", exitCode };
		for (const socket of run.sockets) {
			if (socket.readyState !== socket.OPEN) continue;
			socket.send(JSON.stringify(run.final));
			socket.close(1000, "run finished");
		}
		run.sockets.clear();
	}

	app.get("/projects/:slug/checks", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const file = readFakeChecks(request, slug);
		const prefix = `${keyOf(request)}\u0000${slug}\u0000`;
		const runs: CheckRun[] = [];
		for (const [id, run] of checkRuns) {
			if (id.startsWith(prefix)) runs.push(run.meta);
		}
		return { checks: file.checks, error: file.error, runs };
	});

	app.post("/projects/:slug/checks/:id/runs", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const check = readFakeChecks(request, slug).checks.find(
			(candidate) => candidate.id === id,
		);
		if (!check) {
			return reply
				.status(404)
				.send({ error: { code: "CHECK_NOT_FOUND", message: "no such check" } });
		}
		const runKey = checkRunKey(request, slug, id);
		const existing = checkRuns.get(runKey);
		if (existing && existing.meta.state === "running") {
			return reply.status(409).send({
				error: { code: "CHECK_RUNNING", message: "that check is already running" },
			});
		}
		checkRunCounter += 1;
		const run: FakeCheckRun = {
			meta: {
				id: `fake-${checkRunCounter}`,
				checkId: id,
				state: "running",
				startedAt: new Date().toISOString(),
			},
			lines: [`$ ${check.command}`, `running ${check.name}`],
			sockets: new Set<WebSocket>(),
			final: null,
		};
		checkRuns.set(runKey, run);
		if (!check.command.includes("sleep")) {
			const failing = /(^|\s)(false|exit 1|fail)(\s|$)/.test(check.command);
			run.lines.push(failing ? "1 test failed" : "all tests passed");
			finishFakeRun(run, failing ? 1 : 0);
		}
		return reply.status(201).send(run.meta);
	});

	app.delete("/projects/:slug/checks/:id/runs/current", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		const run = checkRuns.get(checkRunKey(request, slug, id));
		if (run?.meta.state !== "running") {
			return reply.status(404).send({
				error: { code: "CHECK_NOT_RUNNING", message: "that check is not running" },
			});
		}
		run.lines.push("stopped");
		finishFakeRun(run, 130);
		return reply.status(204).send();
	});

	app.get(
		"/projects/:slug/checks/:id/runs/current",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const { slug, id } = request.params as { slug: string; id: string };
			const run = checkRuns.get(checkRunKey(request, slug, id));
			if (!run) {
				socket.send(JSON.stringify({ type: "error", code: "CHECK_NOT_RUNNING" }));
				socket.close(4404, "CHECK_NOT_RUNNING");
				return;
			}
			for (const line of run.lines) {
				socket.send(
					JSON.stringify({
						type: "output",
						data: Buffer.from(`${line}\r\n`, "utf8").toString("base64"),
					}),
				);
			}
			if (run.final) {
				socket.send(JSON.stringify(run.final));
				socket.close(1000, "run finished");
				return;
			}
			run.sockets.add(socket);
			socket.on("close", () => run.sockets.delete(socket));
		},
	);

	app.get(
		"/projects/:slug/events",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const slug = (request.params as { slug: string }).slug;
			// Anything the browser sends must never reach here; count it so a
			// test can prove the pipe is one-way.
			socket.on("message", () => {
				state.eventsReceived += 1;
			});
			socket.on("close", (code: number, reason: Buffer) => {
				eventCloses.push({ code, reason: reason.toString() });
			});
			// Like the real agent, the reason is an error frame and the close
			// code only carries the kind of failure (SPEC.md §11.4).
			if (!dirs(request).has(slug)) {
				socket.send(JSON.stringify({ type: "error", code: "PROJECT_NOT_FOUND" }));
				socket.close(4404, "PROJECT_NOT_FOUND");
				return;
			}
			if (state.eventLimit) {
				socket.send(JSON.stringify({ type: "error", code: "EVENT_SOCKET_LIMIT" }));
				socket.close(1008, "EVENT_SOCKET_LIMIT");
				return;
			}
			const key = answerKey(keyOf(request), slug);
			if (watchFailures.has(key)) {
				socket.send(JSON.stringify({ type: "error", code: "WATCH_FAILED" }));
				socket.close(1011, "WATCH_FAILED");
				return;
			}
			const peers = eventSockets.get(key) ?? new Set<WebSocket>();
			peers.add(socket);
			eventSockets.set(key, peers);
			socket.on("close", () => peers.delete(socket));
			// The real agent says the watcher is live before anything else.
			socket.send(
				JSON.stringify({ type: "fs", paths: [], git: true, truncated: true }),
			);
		},
	);

	/** Push one frame to every events subscriber of a project. */
	function pushEvent(key: string, slug: string, frame: unknown): number {
		const peers = eventSockets.get(answerKey(key, slug)) ?? new Set<WebSocket>();
		let sent = 0;
		for (const peer of peers) {
			if (peer.readyState !== peer.OPEN) continue;
			peer.send(JSON.stringify(frame));
			sent += 1;
		}
		return sent;
	}

	/** Push a frame past the control plane's 1 MiB cap on the agent socket. */
	function pushOversizedEvent(key: string, slug: string): number {
		const paths = ["x".repeat(1024 * 1024 + 1024)];
		return pushEvent(key, slug, { type: "fs", paths, git: false, truncated: false });
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
			pushEvent(key, slug, {
				type: "fs",
				paths: [...flushed],
				git: false,
				truncated: false,
			});
		}, 50);
		timer.unref?.();
		pendingFsTimers.set(id, timer);
	}

	// Test-only hooks for Git, search and events.
	app.post("/__test/git", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			status?: GitStatus;
			diffs?: Record<string, GitDiff>;
		};
		gitAnswers.set(answerKey(body.key ?? "", body.slug), {
			status: body.status,
			diffs: body.diffs,
		});
		return reply.status(204).send();
	});

	app.post("/__test/search", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			matches: SearchMatch[];
			truncated?: boolean;
		};
		const key = answerKey(body.key ?? "", body.slug);
		searchAnswers.set(key, body.matches);
		searchTruncated.set(key, body.truncated ?? false);
		return reply.status(204).send();
	});

	// What the last search of one project actually asked for.
	app.get("/__test/search/last", async (request) => {
		const query = request.query as { key?: string; slug: string };
		return lastSearches.get(answerKey(query.key ?? "", query.slug)) ?? null;
	});

	app.post("/__test/events", async (request, reply) => {
		const body = request.body as {
			key?: string;
			slug: string;
			frame?: unknown;
			oversized?: boolean;
		};
		const sent = body.oversized
			? pushOversizedEvent(body.key ?? "", body.slug)
			: pushEvent(body.key ?? "", body.slug, body.frame);
		return reply.status(200).send({ sent });
	});

	// Test-only hooks for the filesystem. The path carries the project slug,
	// so seeding is the same shape as the map key.
	app.post("/__test/files", async (request, reply) => {
		const body = request.body as { key?: string; path: string; content: string };
		const tree = filesForKey(body.key ?? "");
		const [slug, ...rest] = body.path.split("/");
		if (!slug || rest.length === 0) {
			return reply
				.status(400)
				.send({ error: { code: "PATH_INVALID", message: "need <slug>/<path>" } });
		}
		addParents(tree, slug, rest.join("/"));
		tree.set(body.path, { type: "file", content: Buffer.from(body.content, "utf8") });
		noteFsChange(body.key ?? "", slug, [rest.join("/")]);
		return reply.status(204).send();
	});

	app.get("/__test/files", async (request, reply) => {
		const query = request.query as { key?: string; path?: string };
		const node = filesForKey(query.key ?? "").get(query.path ?? "");
		if (node?.type !== "file") {
			return reply
				.status(404)
				.send({ error: { code: "FILE_NOT_FOUND", message: "no such file" } });
		}
		return { content: node.content.toString("utf8") };
	});

	app.delete("/__test/files", async (request, reply) => {
		const query = request.query as { key?: string; path?: string };
		const target = query.path ?? "";
		filesForKey(query.key ?? "").delete(target);
		const [slug, ...rest] = target.split("/");
		if (slug && rest.length > 0) noteFsChange(query.key ?? "", slug, [rest.join("/")]);
		return reply.status(204).send();
	});

	// Test-only hooks: seed or remove a directory without going through the
	// API. "key" picks the workspace listing the bearer token would have.
	app.post("/__test/projects", async (request, reply) => {
		const body = request.body as { slug: string; isGitRepo?: boolean; key?: string };
		dirsForKey(body.key ?? "").set(body.slug, {
			isGitRepo: body.isGitRepo ?? true,
			directoryId: nextDirectoryId(),
		});
		return reply.status(204).send();
	});

	// Rename a directory the way `mv` in the shell does: the same directory
	// under a new name, so its identity is unchanged (issue #238).
	app.post("/__test/projects/:slug/move", async (request, reply) => {
		const from = (request.params as { slug: string }).slug;
		const to = (request.body as { to: string }).to;
		const key = (request.query as { key?: string }).key ?? "";
		const here = dirsForKey(key);
		const directory = here.get(from);
		if (!directory) return projectNotFound(reply);
		here.delete(from);
		here.set(to, directory);
		rekeyTree(filesForKey(key), from, to, { copy: false });
		return reply.status(204).send();
	});

	app.get("/__test/projects", async (request) => {
		const key = (request.query as { key?: string }).key ?? "";
		return { slugs: [...dirsForKey(key).keys()] };
	});

	app.delete("/__test/projects/:slug", async (request, reply) => {
		const key = (request.query as { key?: string }).key ?? "";
		dirsForKey(key).delete((request.params as { slug: string }).slug);
		return reply.status(204).send();
	});

	/** Send one line of output to every attachment, and remember it. */
	function emit(id: string, payload: string): void {
		const lines = history.get(id) ?? [];
		lines.push(payload);
		history.set(id, lines);
		for (const peer of attached.get(id) ?? []) {
			if (peer.readyState === peer.OPEN) {
				peer.send(Buffer.from(payload), { binary: true });
			}
		}
	}

	/**
	 * Every frame the fake has been sent with the terminal it arrived on, so a
	 * browser test can read its own terminal's frames. One fake agent serves
	 * every workspace in a run, so an unscoped list would mix the workers up.
	 */
	app.get("/__test/received", async () => ({ received: receivedByTerminal }));

	/** How many attachments the fake has for a terminal, so a test can wait. */
	app.get("/__test/terminals/:id/attachments", async (request) => {
		const id = (request.params as { id: string }).id;
		return { attachments: attached.get(id)?.size ?? 0 };
	});

	// Say a full-screen program has taken the terminal, or given it back, the
	// way the real agent does when it sees tmux's alternate screen.
	app.post("/__test/terminals/:id/screen", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { alternate: boolean };
		for (const peer of attached.get(id) ?? []) {
			if (peer.readyState === peer.OPEN) {
				peer.send(JSON.stringify({ type: "screen", alternate: body.alternate }));
			}
		}
		return reply.status(204).send();
	});

	// Output a test wants on screen without typing for it, so a browser test
	// can fill the scrollback.
	app.post("/__test/terminals/:id/output", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { lines: string[] };
		emit(id, `${body.lines.join("\r\n")}\r\n`);
		return reply.status(204).send();
	});

	app.get(
		"/terminals/:id/attach",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const id = (request.params as { id: string }).id;
			if (!terminals.has(id)) {
				socket.close(4404, "no such terminal");
				return;
			}
			state.openAttachments += 1;
			const peers = attached.get(id) ?? new Set<WebSocket>();
			peers.add(socket);
			attached.set(id, peers);
			socket.on("close", () => {
				state.openAttachments -= 1;
				peers.delete(socket);
			});
			const query = request.query as { cols?: string; rows?: string };
			// Earlier output first, then blank lines to push it into the
			// browser's scrollback, exactly as the real agent does.
			const earlier = history.get(id) ?? [];
			if (earlier.length > 0) {
				const rows = Number(query.rows ?? "24");
				const blank = "\r\n".repeat(Number.isFinite(rows) ? rows : 24);
				socket.send(Buffer.from(`${earlier.join("\r\n")}\r\n${blank}`), {
					binary: true,
				});
			}
			socket.send(JSON.stringify({ type: "size", cols: query.cols, rows: query.rows }));
			socket.on("message", (data: Buffer) => {
				const text = data.toString();
				received.push(text);
				receivedByTerminal.push({ terminalId: id, text });
				const parsed = JSON.parse(text) as { type: string; cols?: number };
				if (parsed.type === "resize") {
					socket.send(JSON.stringify({ type: "size", cols: parsed.cols }));
					return;
				}
				const broadcast = (payload: string) => emit(id, payload);
				broadcast(`echo:${text}`);
				// A shell prints ^C when the interrupt byte reaches it, and the
				// clipboard tests need to see that Ctrl+C got through.
				const inputData = (parsed as { data?: unknown }).data;
				if (parsed.type === "input" && typeof inputData === "string") {
					if (inputData.includes("\u0003")) broadcast("^C");
					// A `cd` moves the terminal, which the real agent notices by
					// polling tmux and reports as a cwd frame (SPEC.md §9.3).
					const moved = /cd\s+(\S+)/.exec(inputData);
					if (moved?.[1]) {
						for (const peer of peers) {
							if (peer.readyState === peer.OPEN) {
								peer.send(JSON.stringify({ type: "cwd", path: moved[1] }));
							}
						}
					}
					// Ctrl+D ends the shell, and a shell that ends closes its pane.
					if (inputData.includes("\u0004")) {
						for (const peer of peers) {
							if (peer.readyState === peer.OPEN) {
								peer.send(JSON.stringify({ type: "exit" }));
							}
						}
					}
				}
			});
		},
	);

	// ── Listening services and loopback forwards (BROWSER-HANDLING.md §11.1) ──

	app.get("/listening", async (request) => ({
		services: listeningFor(keyOf(request)),
	}));

	app.get(
		"/listening/events",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const key = keyOf(request);
			const peers = listeningSockets.get(key) ?? new Set<WebSocket>();
			peers.add(socket);
			listeningSockets.set(key, peers);
			socket.on("close", () => peers.delete(socket));
			// Like the real agent, the first frame is the whole list.
			sendListening(socket, listeningFor(key));
		},
	);

	app.get("/forwards", async (request) => ({
		forwards: [...(forwards.get(keyOf(request)) ?? new Set<number>())].map((port) => ({
			port,
			address: "10.0.0.2",
			state: "open" as const,
		})),
	}));

	app.post("/forwards", async (request, reply) => {
		const body = request.body as { port?: number };
		const port = body?.port;
		if (typeof port !== "number") {
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid port" } });
		}
		if (state.failForward) {
			return reply
				.status(409)
				.send({ error: { code: "INTERNAL", message: "cannot bind" } });
		}
		const key = keyOf(request);
		const open = forwards.get(key) ?? new Set<number>();
		open.add(port);
		forwards.set(key, open);
		markForwarded(key, port, true);
		return { port, address: "10.0.0.2", state: "open" };
	});

	app.delete("/forwards/:port", async (request, reply) => {
		const port = Number.parseInt((request.params as { port: string }).port, 10);
		const key = keyOf(request);
		const open = forwards.get(key) ?? new Set<number>();
		if (!open.delete(port)) {
			return reply
				.status(404)
				.send({ error: { code: "INTERNAL", message: "no such forward" } });
		}
		markForwarded(key, port, false);
		return reply.status(204).send();
	});

	/**
	 * Seed what the workspace is listening on. The body is the whole list, so
	 * a test can also clear it by sending an empty array.
	 */
	app.post("/__test/listening", async (request, reply) => {
		const body = request.body as {
			key?: string;
			services?: Partial<AgentListeningService>[];
		};
		const key = body.key ?? "";
		listening.set(
			key,
			(body.services ?? []).map((service) => ({
				port: service.port ?? 0,
				addresses: service.addresses ?? ["0.0.0.0"],
				protocolHint: service.protocolHint ?? "http",
				previewReachability: service.previewReachability ?? "reachable",
				observedAt: new Date().toISOString(),
			})),
		);
		pushListening(key);
		return reply.status(204).send();
	});

	/**
	 * Start a tiny HTTP and WebSocket application on a free port and report it
	 * as listening, so an end-to-end test can drive a real preview.
	 */
	app.post("/__test/app", async (request, reply) => {
		const body = (request.body ?? {}) as { key?: string; title?: string };
		const key = body.key ?? "";
		const title = body.title ?? "Portikus test app";
		const port = await startTestApp(title);
		const current = listeningFor(key).filter((one) => one.port !== port);
		listening.set(key, [
			...current,
			{
				port,
				addresses: ["0.0.0.0"],
				protocolHint: "http",
				previewReachability: "reachable",
				observedAt: new Date().toISOString(),
			},
		]);
		pushListening(key);
		return reply.status(201).send({ port });
	});

	await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;

	return {
		port: address.port,
		token,
		terminals,
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
			return state.searchAborted;
		},
		get eventsReceived() {
			return state.eventsReceived;
		},
		get eventLimit() {
			return state.eventLimit;
		},
		set eventLimit(value: boolean) {
			state.eventLimit = value;
		},
		get failLogLevel() {
			return state.failLogLevel;
		},
		set failLogLevel(value: boolean) {
			state.failLogLevel = value;
		},
		get openAttachments() {
			return state.openAttachments;
		},
		get failCreateWith() {
			return state.failCreateWith;
		},
		set failCreateWith(code: string | null) {
			state.failCreateWith = code;
		},
		listening,
		forwards,
		get failForward() {
			return state.failForward;
		},
		set failForward(value: boolean) {
			state.failForward = value;
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
