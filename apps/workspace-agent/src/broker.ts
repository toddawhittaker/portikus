import { chmod, mkdir, readFile, readlink, realpath, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename } from "node:path";
import {
	type BrokerOpenReply,
	BrokerOpenRequest,
	BrowserOpenRequest,
	classifyBrokerUrl,
	redactUrl,
} from "@portikus/contracts";
import type { FastifyBaseLogger } from "fastify";
import { projectsDir } from "./projects.js";
import type { ProjectWatchers } from "./watch.js";

/** Where `portikus-open` connects (BROWSER-HANDLING.md §18). */
export const BROWSER_SOCKET_PATH = "/run/portikus/browser.sock";

/** How long a repeated requestId is one frame (BROWSER-HANDLING.md §25.2). */
const DEDUP_MS = 5_000;

/** One line is one request. Longer than that is not a URL we will read. */
const MAX_LINE_BYTES = 8192;

/** Used until the controller tells the agent which workspace it is. */
const NIL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BrokerOptions {
	socketPath: string;
	homeDir: string;
	watchers: ProjectWatchers;
	workspaceId?: string;
	log: FastifyBaseLogger;
}

export interface BrokerHandle {
	close: () => Promise<void>;
}

/**
 * One JSON line in, one JSON line out, on a socket mode 0600
 * (BROWSER-HANDLING.md §18, §21.3). Frames go out on the project events
 * socket that is already open. The URL is never logged.
 */
export function startUrlBroker(options: BrokerOptions): Promise<BrokerHandle> {
	const workspaceId =
		options.workspaceId && UUID.test(options.workspaceId)
			? options.workspaceId
			: NIL_WORKSPACE_ID;
	const recent = new Map<string, number>();
	const server = createServer((socket) => {
		accept(socket, options, workspaceId, recent);
	});

	return new Promise((resolve) => {
		const finish = (handle: BrokerHandle) => {
			resolve(handle);
		};
		const fail = (error: NodeJS.ErrnoException) => {
			options.log.warn({ code: error.code ?? "UNKNOWN" }, "browser socket failed");
			finish({ close: async () => {} });
		};
		server.on("error", fail);
		void mkdir(dirnameOf(options.socketPath), { recursive: true, mode: 0o700 })
			.then(() => unlink(options.socketPath).catch(() => {}))
			.then(() => {
				server.listen(options.socketPath, () => {
					server.off("error", fail);
					void chmod(options.socketPath, 0o600)
						.catch((error: NodeJS.ErrnoException) => {
							options.log.warn(
								{ code: error.code ?? "UNKNOWN" },
								"browser socket mode failed",
							);
						})
						.finally(() => {
							finish({
								close: () => closeServer(server, options.socketPath),
							});
						});
				});
			})
			.catch(fail);
	});
}

function dirnameOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash <= 0 ? "/" : path.slice(0, slash);
}

function closeServer(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			void unlink(socketPath)
				.catch(() => {})
				.finally(() => resolve());
		});
	});
}

function accept(
	socket: Socket,
	options: BrokerOptions,
	workspaceId: string,
	recent: Map<string, number>,
): void {
	let buffer = "";
	let chain = Promise.resolve();
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
			buffer = "";
			writeReply(socket, { ok: false, reason: "too-long" });
			return;
		}
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			chain = chain.then(() => handleLine(socket, line, options, workspaceId, recent));
		}
	});
}

async function handleLine(
	socket: Socket,
	line: string,
	options: BrokerOptions,
	workspaceId: string,
	recent: Map<string, number>,
): Promise<void> {
	const trimmed = line.trim();
	if (trimmed === "") return;
	let body: unknown;
	try {
		body = JSON.parse(trimmed);
	} catch {
		writeReply(socket, { ok: false, reason: "invalid" });
		return;
	}
	const parsed = BrokerOpenRequest.safeParse(body);
	if (!parsed.success) {
		writeReply(socket, { ok: false, reason: "invalid" });
		return;
	}
	const classified = classifyBrokerUrl(parsed.data.url);
	if (classified.outcome === "reject") {
		writeReply(socket, { ok: false, reason: classified.reason });
		return;
	}

	const now = Date.now();
	for (const [id, at] of recent) {
		if (now - at > DEDUP_MS) recent.delete(id);
	}
	if (recent.has(parsed.data.requestId)) {
		writeReply(socket, { ok: true });
		return;
	}

	const executable = parsed.data.executable;
	const brokerClass =
		classified.outcome === "external"
			? "external"
			: (await processIsCodex(executable, parsed.data.pid))
				? "loopback-login"
				: "loopback-preview";

	const source =
		executable || parsed.data.pid !== undefined || parsed.data.cwd
			? {
					...(executable ? { executable } : {}),
					...(parsed.data.pid !== undefined ? { pid: parsed.data.pid } : {}),
					...(parsed.data.cwd ? { cwd: parsed.data.cwd } : {}),
				}
			: undefined;

	const frame = BrowserOpenRequest.parse({
		type: "browser.open.request",
		requestId: parsed.data.requestId,
		workspaceId,
		url: parsed.data.url,
		brokerClass,
		...(source ? { source } : {}),
		requestedAt: new Date().toISOString(),
	});

	const root = await projectRoot(options.homeDir, parsed.data.cwd);
	const delivered = root ? options.watchers.publish(root, frame) : false;
	// Origin only, and only because this line exists at all (BROWSER-HANDLING.md §21.3).
	options.log.debug(
		{ origin: redactUrl(parsed.data.url), brokerClass },
		"browser open",
	);
	if (!delivered) {
		writeReply(socket, {
			ok: false,
			reason: root ? "no-subscriber" : "no-project",
		});
		return;
	}
	recent.set(parsed.data.requestId, now);
	writeReply(socket, { ok: true });
}

/** Basename `codex` (or a Node script of that name). The URL text is not consulted. */
const CODEX_COMMAND = new Set(["codex", "codex.js", "codex.mjs", "codex.cjs"]);

function commandIsCodex(path: string): boolean {
	return CODEX_COMMAND.has(basename(path));
}

/**
 * Codex's CLI is a Node program, so `/proc/<pid>/exe` is `node`. The command
 * line names the codex program (BROWSER-HANDLING.md §19).
 */
async function processIsCodex(
	executable: string | undefined,
	pid: number | undefined,
): Promise<boolean> {
	if (executable && commandIsCodex(executable)) return true;
	if (pid === undefined || pid <= 0) return false;
	try {
		if (commandIsCodex(await readlink(`/proc/${pid}/exe`))) return true;
	} catch {
		// The exe link can be gone. The command line is the other check.
	}
	try {
		const raw = await readFile(`/proc/${pid}/cmdline`);
		return raw
			.toString("utf8")
			.split("\0")
			.some((arg) => arg.length > 0 && commandIsCodex(arg));
	} catch {
		return false;
	}
}

function writeReply(socket: Socket, reply: BrokerOpenReply): void {
	if (!socket.writable) return;
	socket.write(`${JSON.stringify(reply)}\n`);
}

/**
 * The project directory a cwd sits in, which is the key the events watcher
 * uses. Null when the path is not inside `~/projects/<slug>`.
 */
async function projectRoot(
	homeDir: string,
	cwd: string | undefined,
): Promise<string | null> {
	if (!cwd) return null;
	let root: string;
	let real: string;
	try {
		root = await realpath(projectsDir(homeDir));
		real = await realpath(cwd);
	} catch {
		return null;
	}
	if (real !== root && !real.startsWith(`${root}/`)) return null;
	const slug = real.slice(root.length + 1).split("/")[0];
	if (!slug || slug.startsWith(".")) return null;
	try {
		return await realpath(`${root}/${slug}`);
	} catch {
		return null;
	}
}
