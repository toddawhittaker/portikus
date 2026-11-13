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

/** How long a repeated requestId is one frame (BROWSER-HANDLING.md §25.2). */
const DEDUP_MS = 5_000;

/** One line is one request. Longer than that is not a URL we will read. */
const MAX_LINE_BYTES = 8192;

/**
 * The API names the workspace from its own records; an id from inside the
 * container could not be trusted.
 */
const NIL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export interface BrokerOptions {
	socketPath: string;
	homeDir: string;
	watchers: ProjectWatchers;
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
	const recent = new Map<string, number>();
	const server = createServer((socket) => {
		accept(socket, options, recent);
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
			chain = chain.then(() => handleLine(socket, line, options, recent));
		}
	});
}

async function handleLine(
	socket: Socket,
	line: string,
	options: BrokerOptions,
	recent: Map<string, number>,
): Promise<void> {
	const trimmed = line.trim();
	if (trimmed === "") return;
	const request = parseRequest(trimmed);
	if (!request) {
		writeReply(socket, { ok: false, reason: "invalid" });
		return;
	}
	const classified = classifyBrokerUrl(request.url);
	if (classified.outcome === "reject") {
		writeReply(socket, { ok: false, reason: classified.reason });
		return;
	}

	const now = Date.now();
	forgetExpired(recent, now);
	if (recent.has(request.requestId)) {
		writeReply(socket, { ok: true });
		return;
	}

	const brokerClass =
		classified.outcome === "external"
			? "external"
			: (await processIsCodex(request.executable, request.pid))
				? "loopback-login"
				: "loopback-preview";
	const source = requestSource(request);

	const frame = BrowserOpenRequest.parse({
		type: "browser.open.request",
		requestId: request.requestId,
		workspaceId: NIL_WORKSPACE_ID,
		url: request.url,
		brokerClass,
		...(source ? { source } : {}),
		requestedAt: new Date().toISOString(),
	});

	const root = await projectRoot(options.homeDir, request.cwd);
	const delivered = root ? options.watchers.publish(root, frame) : false;
	// Origin only, and only because this line exists at all (BROWSER-HANDLING.md §21.3).
	options.log.debug({ origin: redactUrl(request.url), brokerClass }, "browser open");
	if (!delivered) {
		writeReply(socket, {
			ok: false,
			reason: root ? "no-subscriber" : "no-project",
		});
		return;
	}
	recent.set(request.requestId, now);
	writeReply(socket, { ok: true });
}

function parseRequest(text: string): BrokerOpenRequest | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = BrokerOpenRequest.safeParse(body);
	return parsed.success ? parsed.data : null;
}

function forgetExpired(recent: Map<string, number>, now: number): void {
	for (const [id, at] of recent) {
		if (now - at > DEDUP_MS) recent.delete(id);
	}
}

/** Who asked, as far as the shim could tell; undefined when it told nothing. */
function requestSource(
	request: BrokerOpenRequest,
): { executable?: string; pid?: number; cwd?: string } | undefined {
	const { executable, pid, cwd } = request;
	if (!executable && pid === undefined && !cwd) return undefined;
	return {
		...(executable ? { executable } : {}),
		...(pid !== undefined ? { pid } : {}),
		...(cwd ? { cwd } : {}),
	};
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
