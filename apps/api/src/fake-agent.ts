import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import websocket, { type WebSocket } from "@fastify/websocket";
import {
	MAX_EDITOR_FILE_BYTES,
	MAX_UPLOAD_BYTES,
	ProjectPath,
} from "@portikus/contracts";
import Fastify, {
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
} from "fastify";

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
	projects: Map<string, { isGitRepo: boolean }>;
	/** Everything under those directories, keyed the same way as the listings. */
	files: Map<string, FakeNode>;
	close: () => Promise<void>;
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
	const projects = new Map<string, { isGitRepo: boolean }>();
	const files = new Map<string, FakeNode>();
	const perKeyFiles = new Map<string, Map<string, FakeNode>>();
	// One fake agent stands in for every workspace in an end-to-end run, so a
	// token of the form "<token>:<key>" gets its own ~/projects listing and
	// workspaces do not discover each other's directories.
	const perKey = new Map<string, Map<string, { isGitRepo: boolean }>>();
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

	const state = {
		failCreateWith: null as string | null,
		openAttachments: 0,
		failLogLevel: false,
	};
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
	function dirsForKey(key: string): Map<string, { isGitRepo: boolean }> {
		if (key === "") return projects;
		let dirs = perKey.get(key);
		if (!dirs) {
			dirs = new Map();
			perKey.set(key, dirs);
		}
		return dirs;
	}

	/** The workspace key on the caller's bearer token; "" is the shared one. */
	function keyOf(request: FastifyRequest): string {
		const header = request.headers.authorization ?? "";
		const prefix = `Bearer ${token}:`;
		return header.startsWith(prefix) ? header.slice(prefix.length) : "";
	}

	/** The caller's ~/projects, from the suffix on its bearer token. */
	function dirs(request: FastifyRequest): Map<string, { isGitRepo: boolean }> {
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
			slug,
			isGitRepo: value.isGitRepo,
		})),
	}));

	app.get("/projects/:slug", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const project = dirs(request).get(slug);
		if (!project) return projectNotFound(reply);
		return { slug, isGitRepo: project.isGitRepo };
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
		here.set(body.slug, { isGitRepo });
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
		here.set(to, { isGitRepo: project.isGitRepo });
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
			return reply.status(204).send();
		} catch (error) {
			return fileError(reply, error as FakeFileError);
		}
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
		filesForKey(query.key ?? "").delete(query.path ?? "");
		return reply.status(204).send();
	});

	// Test-only hooks: seed or remove a directory without going through the
	// API. "key" picks the workspace listing the bearer token would have.
	app.post("/__test/projects", async (request, reply) => {
		const body = request.body as { slug: string; isGitRepo?: boolean; key?: string };
		dirsForKey(body.key ?? "").set(body.slug, { isGitRepo: body.isGitRepo ?? true });
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

	await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;

	return {
		port: address.port,
		token,
		terminals,
		received,
		projects,
		files,
		logLevels,
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
		close: () => app.close(),
	};
}
