import type { AddressInfo } from "node:net";
import websocket, { type WebSocket } from "@fastify/websocket";
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
	close: () => Promise<void>;
}

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
	const projects = new Map<string, { isGitRepo: boolean }>();
	// One fake agent stands in for every workspace in an end-to-end run, so a
	// token of the form "<token>:<key>" gets its own ~/projects listing and
	// workspaces do not discover each other's directories.
	const perKey = new Map<string, Map<string, { isGitRepo: boolean }>>();
	const app: FastifyInstance = Fastify({ logger: false });
	await app.register(websocket);

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

	/** The caller's ~/projects, from the suffix on its bearer token. */
	function dirs(request: FastifyRequest): Map<string, { isGitRepo: boolean }> {
		const header = request.headers.authorization ?? "";
		const prefix = `Bearer ${token}:`;
		return dirsForKey(header.startsWith(prefix) ? header.slice(prefix.length) : "");
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
		return reply
			.header("content-type", "application/zip")
			.send(oneFileZip(`${slug}/README.md`, `# ${slug}\n`));
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

	/** Every frame the fake has been sent, so a browser test can read it. */
	app.get("/__test/received", async () => ({ received }));

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
