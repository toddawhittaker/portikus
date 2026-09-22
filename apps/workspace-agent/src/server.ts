import { basename } from "node:path";
import type { Readable } from "node:stream";
import websocket, { type WebSocket } from "@fastify/websocket";
import {
	AgentCreateProjectRequest,
	AgentCreateTerminalRequest,
	AgentDuplicateProjectRequest,
	AgentRenameProjectRequest,
	contentDisposition,
	MAX_TERMINALS_PER_WORKSPACE,
	MkdirRequest,
	MoveRequest,
	SetLogLevelRequest,
	TerminalId,
} from "@portikus/contracts";
import {
	applyLevel,
	type Logger,
	type LogLevel,
	quietLogController,
	registerRequestLogging,
	silentLogger,
} from "@portikus/observability";
import Fastify, {
	type FastifyBaseLogger,
	type FastifyInstance,
	type FastifyRequest,
} from "fastify";
import { z } from "zod";
import { tokenAuth } from "./auth.js";
import { startUrlBroker } from "./broker.js";
import { checksRoute } from "./checks-route.js";
import { ERROR_STATUS, sendError } from "./errors.js";
import { eventsRoute } from "./events-route.js";
import {
	listDir,
	mkdir,
	move,
	readFile,
	remove,
	resolveInProject,
	writeFile,
} from "./files.js";
import { Forwards } from "./forwards.js";
import { recordBaseline } from "./git.js";
import { registerGitRoutes } from "./git-routes.js";
import {
	ListeningMonitor,
	type ListeningMonitorOptions,
	workspaceInterfaceAddress,
} from "./listening.js";
import { listeningRoutes } from "./listening-route.js";
import {
	type ArchiveProcess,
	archiveDir,
	archiveProject,
	createProject,
	deleteProject,
	duplicateProject,
	getProject,
	gitInitProject,
	listProjects,
	renameProject,
	STDERR_LIMIT,
} from "./projects.js";
import { registerSearchRoutes } from "./search-routes.js";
import { TerminalRegistry } from "./terminals.js";
import {
	AgentFailure,
	commandForAgent,
	createSession,
	hasSession,
	killSession,
	listSessions,
} from "./tmux.js";
import { UsageSampler, type UsageSamplerOptions } from "./usage.js";
import { ProjectWatchers } from "./watch.js";

const IdParam = z.object({ terminalId: TerminalId });

/** File routes carry the project-relative path in the query; "" is the root. */
const PathQuery = z.object({
	path: z.string().max(1024).optional(),
	download: z.string().optional(),
	upload: z.string().optional(),
});

function queryPath(request: FastifyRequest): {
	path: string;
	download: boolean;
	upload: boolean;
} {
	const parsed = PathQuery.safeParse(request.query ?? {});
	if (!parsed.success) {
		throw new AgentFailure("PATH_INVALID", "invalid path");
	}
	return {
		path: parsed.data.path ?? "",
		download: parsed.data.download === "1",
		upload: parsed.data.upload === "1",
	};
}

const AttachQuery = z.object({
	cols: z.coerce.number().int().min(1).max(1000).optional(),
	rows: z.coerce.number().int().min(1).max(1000).optional(),
});

export interface ServerOptions {
	tokenPath: string;
	homeDir: string;
	tmuxSocketName?: string;
	/** The process logger. Tests default to one that writes nothing. */
	logger?: Logger;
	/** Overrides the cap on concurrent event sockets. For tests. */
	maxEventSockets?: number;
	/** Overrides the project watchers, so a test can break one. For tests. */
	watchers?: ProjectWatchers;
	/** Overrides where ports are discovered and how. For tests. */
	listening?: ListeningMonitorOptions;
	/**
	 * Unix socket for `portikus-open`. Unset in tests that do not exercise
	 * the broker; production passes `/run/portikus/browser.sock`.
	 */
	brokerSocketPath?: string;
	/** Workspace id stamped on browser-open frames. */
	workspaceId?: string;
	/** Overrides where usage is read. For tests. */
	usage?: UsageSamplerOptions;
}

/** The workspace agent's HTTP and WebSocket surface (SPEC.md §9.7). */
export function buildServer(options: ServerOptions): FastifyInstance {
	// Keep the root logger: Fastify wraps it in a child, so setting a level on
	// the instance would leave this process's own debug lines silent (ADR 0012).
	const rootLogger = options.logger ?? silentLogger();
	const app = Fastify({
		// Fastify's default body limit stands for every route. The file write
		// route reads the raw stream and caps it itself (SPEC.md §11.2).
		// Cast so the instance keeps Fastify's default logger type and
		// callers can still hold it as a plain FastifyInstance.
		loggerInstance: rootLogger as FastifyBaseLogger,
		logController: quietLogController(),
	});
	// Usage is polled once a second and its body names processes, so the
	// request line stays at debug and the body is never logged (STACK.md §15).
	registerRequestLogging(app, { debugPaths: ["/health", "/usage"] });

	// The level to return to when the API clears the override (ADR 0012).
	const startLevel = rootLogger.level as LogLevel;

	const registry = new TerminalRegistry(
		options.homeDir,
		app.log,
		options.tmuxSocketName,
	);
	const watchers = options.watchers ?? new ProjectWatchers(app.log);

	let closeBroker: () => Promise<void> = async () => {};
	if (options.brokerSocketPath) {
		const pending = startUrlBroker({
			socketPath: options.brokerSocketPath,
			homeDir: options.homeDir,
			watchers,
			workspaceId: options.workspaceId,
			log: app.log,
		});
		closeBroker = async () => {
			const handle = await pending;
			await handle.close();
		};
	}
	app.addHook("preClose", async () => {
		await closeBroker();
	});

	// Registered before @fastify/websocket's own preClose so attachments get a
	// close code before that plugin drops the sockets.
	app.addHook("preClose", async () => {
		registry.closeEverything();
	});

	// Port discovery and loopback forwards know about each other: discovery
	// reports a forwarded port as "forwarded", and a forward closes once its
	// loopback listener is gone (BROWSER-HANDLING.md §11.1).
	const monitor = new ListeningMonitor({
		...options.listening,
		logger: app.log,
		forwardedPorts: () => forwards.ports(),
	});
	const forwards = new Forwards({
		interfaceAddress:
			options.listening?.interfaceAddress === undefined
				? workspaceInterfaceAddress()
				: options.listening.interfaceAddress,
		monitor,
		logger: app.log,
	});
	monitor.subscribe(() => {
		forwards.reconcile();
	});
	monitor.start();

	const usage = new UsageSampler({
		homePath: options.homeDir,
		...options.usage,
	});

	app.addHook("preClose", async () => {
		monitor.stop();
		forwards.closeEverything();
	});

	// A terminal input frame is small; refuse anything far past that before it
	// is buffered (SPEC.md §9.7).
	app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

	// Every route, the upgrade included, needs the token (SPEC.md §23.5). It
	// runs on request, so a caller without it never gets a body parsed.
	app.addHook("onRequest", tokenAuth(options.tokenPath));

	// A refused upgrade is answered over a socket Fastify does not track, so
	// close it here or shutdown waits for it forever.
	app.addHook("onResponse", async (request, reply) => {
		const upgrade = request.headers.upgrade;
		if (
			typeof upgrade === "string" &&
			upgrade.toLowerCase() === "websocket" &&
			reply.statusCode >= 400
		) {
			request.raw.socket.destroy();
		}
	});

	// Routes live in a child plugin so that @fastify/websocket has loaded and
	// wrapped the upgrade handler before they are registered.
	app.register(async (instance) => {
		instance.get("/health", async () => ({ ok: true }));

		// One sample serves the Monitor tab and the selected Running row.
		// The handler logs nothing: the body carries process names.
		instance.get("/usage", async () => usage.read());

		// The control plane turns debug logging on and off while the agent
		// runs (ADR 0012); the level lives only in this process.
		instance.put("/log-level", async (request, reply) => {
			const parsed = SetLogLevelRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply
					.code(ERROR_STATUS.BAD_REQUEST)
					.send({ error: { code: "BAD_REQUEST", message: "unknown log level" } });
			}
			// Null clears the override, so this agent goes back to the level it
			// started with, from its own environment (ADR 0012).
			applyLevel(rootLogger, startLevel, parsed.data.level);
			return reply.code(204).send();
		});

		instance.get("/terminals", async (request, reply) => {
			try {
				const sessions = await listSessions(options.tmuxSocketName);
				return {
					terminals: sessions.map((session) => ({
						id: session.id,
						cwd: session.cwd,
						attachments: registry.countAttachments(session.id),
					})),
				};
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.post("/terminals", async (request, reply) => {
			const parsed = AgentCreateTerminalRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply.code(400).send({
					error: {
						code: "INVALID_CWD",
						message: parsed.error.issues.map((issue) => issue.message).join("; "),
					},
				});
			}
			try {
				if (await hasSession(parsed.data.id, options.tmuxSocketName)) {
					throw new AgentFailure("TERMINAL_EXISTS", "terminal already exists");
				}
				const sessions = await listSessions(options.tmuxSocketName);
				if (sessions.length >= MAX_TERMINALS_PER_WORKSPACE) {
					throw new AgentFailure(
						"TERMINAL_LIMIT",
						"this workspace already has the maximum number of terminals",
					);
				}
				const created = await createSession(
					parsed.data.id,
					parsed.data.cwd,
					options.homeDir,
					parsed.data.theme,
					parsed.data.timezone,
					options.tmuxSocketName,
					parsed.data.agent
						? {
								command: commandForAgent(parsed.data.agent),
								institutionalEnv: parsed.data.institutionalEnv,
								recordBaseline,
							}
						: undefined,
				);
				request.log.debug(
					{ terminalId: created.id, session: `pk-${created.id}` },
					"tmux session created",
				);
				return reply.code(201).send({
					id: created.id,
					cwd: created.cwd,
					attachments: 0,
					baselineObjectId: created.baselineObjectId,
					baselineHead: created.baselineHead,
				});
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.delete("/terminals/:terminalId", async (request, reply) => {
			const params = IdParam.safeParse(request.params);
			if (!params.success) {
				return reply
					.code(404)
					.send({ error: { code: "TERMINAL_NOT_FOUND", message: "no such terminal" } });
			}
			const { terminalId } = params.data;
			try {
				if (!(await hasSession(terminalId, options.tmuxSocketName))) {
					throw new AgentFailure("TERMINAL_NOT_FOUND", "no such terminal");
				}
				await killSession(terminalId, options.tmuxSocketName);
				registry.closeAll(terminalId, 1000, "terminal deleted");
				request.log.debug(
					{ terminalId, session: `pk-${terminalId}` },
					"tmux session killed",
				);
				return reply.code(204).send();
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.get("/projects", async (request, reply) => {
			try {
				return { projects: await listProjects(options.homeDir) };
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.get("/projects/:slug", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				return await getProject(slug, options.homeDir);
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.post("/projects", async (request, reply) => {
			const parsed = AgentCreateProjectRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply.code(400).send({
					error: {
						code: "INVALID_SLUG",
						message: parsed.error.issues.map((issue) => issue.message).join("; "),
					},
				});
			}
			try {
				const project = await createProject(parsed.data, options.homeDir);
				request.log.debug(
					{ slug: project.slug, operation: "create", source: parsed.data.source },
					"project operation",
				);
				return reply.code(201).send(project);
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.delete("/projects/:slug", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				await deleteProject(slug, options.homeDir);
			} catch (error) {
				return sendError(request, reply, error);
			}
			request.log.info({ slug, operation: "delete" }, "project deleted");
			return reply.code(204).send();
		});

		instance.post("/projects/:slug/rename", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			const parsed = AgentRenameProjectRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_SLUG", message: "invalid target slug" } });
			}
			try {
				const project = await renameProject(slug, parsed.data.to, options.homeDir);
				request.log.debug(
					{ slug, operation: "rename", to: project.slug },
					"project operation",
				);
				return project;
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.post("/projects/:slug/duplicate", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			const parsed = AgentDuplicateProjectRequest.safeParse(request.body);
			if (!parsed.success) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_SLUG", message: "invalid target slug" } });
			}
			try {
				const project = await duplicateProject(slug, parsed.data.to, options.homeDir);
				request.log.debug(
					{ slug, operation: "duplicate", to: project.slug },
					"project operation",
				);
				return project;
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		instance.post("/projects/:slug/git-init", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const project = await gitInitProject(slug, options.homeDir);
				request.log.debug({ slug, operation: "git-init" }, "project operation");
				return project;
			} catch (error) {
				return sendError(request, reply, error);
			}
		});

		registerSearchRoutes(instance, options.homeDir);
		// The file routes. Paths are logged at debug only and file contents
		// never (STACK.md §15, ADR 0012).
		instance.get("/projects/:slug/tree", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const { path } = queryPath(request);
				return await listDir(options.homeDir, slug, path);
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		});

		instance.get("/projects/:slug/file", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const { path, download } = queryPath(request);
				const file = await readFile(options.homeDir, slug, path, { download });
				if (file.etag) {
					reply.header("etag", file.etag);
				}
				reply.header("content-length", String(file.size));
				if (download) {
					reply.header("content-disposition", contentDisposition(basename(path)));
				}
				return reply.type(file.contentType).send(file.stream ?? file.body);
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		});

		// The write route reads the raw request stream for every content type, so
		// the parsers that displace Fastify's JSON and text ones live in this
		// scope alone; every other route keeps Fastify's defaults. The size cap is
		// enforced while the body streams to disk, not by a route body limit,
		// which a stream parser never consults (SPEC.md §11.2).
		instance.register(async (writeScope) => {
			const rawStream = (
				_request: FastifyRequest,
				payload: Readable,
				done: (error: Error | null, body?: Readable) => void,
			) => {
				done(null, payload);
			};
			writeScope.addContentTypeParser("*", rawStream);
			writeScope.addContentTypeParser("application/json", rawStream);
			writeScope.addContentTypeParser("text/plain", rawStream);

			writeScope.put("/projects/:slug/file", async (request, reply) => {
				const { slug } = request.params as { slug: string };
				try {
					const { path, upload } = queryPath(request);
					const ifMatch = request.headers["if-match"];
					const ifNoneMatch = request.headers["if-none-match"];
					// ?upload=1 is the explicit signal. The octet-stream content type is
					// still accepted as an alias for the clients that send it.
					const contentType = request.headers["content-type"] ?? "";
					const result = await writeFile(options.homeDir, slug, path, request.raw, {
						ifMatch: typeof ifMatch === "string" ? unquote(ifMatch) : undefined,
						ifNoneMatch: ifNoneMatch === "*",
						upload: upload || contentType.startsWith("application/octet-stream"),
					});
					reply.header("etag", result.etag);
					return reply.code(200).send(result);
				} catch (error) {
					if (
						error instanceof AgentFailure &&
						error.code === "FILE_TOO_LARGE" &&
						!request.raw.readableEnded
					) {
						// The rest of the body is never read, so the connection cannot be
						// reused; say so, and only tear the socket down once the 413 has
						// gone out, or the client sees a reset instead (SPEC.md §13.5).
						reply.header("connection", "close");
						reply.raw.once("finish", () => {
							request.raw.destroy();
						});
					}
					return sendError(request, reply, error, "INTERNAL");
				}
			});
		});

		instance.delete("/projects/:slug/file", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const { path } = queryPath(request);
				await remove(options.homeDir, slug, path);
				return reply.code(204).send();
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		});

		instance.post("/projects/:slug/mkdir", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const parsed = MkdirRequest.safeParse(request.body);
				if (!parsed.success) {
					throw new AgentFailure("PATH_INVALID", "invalid path");
				}
				await mkdir(options.homeDir, slug, parsed.data.path);
				return reply.code(201).send({ ok: true });
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		});

		instance.post("/projects/:slug/move", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const parsed = MoveRequest.safeParse(request.body);
				if (!parsed.success) {
					throw new AgentFailure("PATH_INVALID", "invalid path");
				}
				await move(options.homeDir, slug, parsed.data.from, parsed.data.to);
				return reply.code(204).send();
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
		});

		instance.get("/projects/:slug/archive", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			let child: ArchiveProcess;
			try {
				const { path } = queryPath(request);
				if (path === "") {
					child = await archiveProject(slug, options.homeDir);
				} else {
					const target = await resolveInProject(options.homeDir, slug, path, {
						mustExist: true,
					});
					child = await archiveDir(target.path);
				}
			} catch (error) {
				return sendError(request, reply, error, "INTERNAL");
			}
			request.log.debug({ slug, operation: "archive" }, "project operation");
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				// zip can be noisy; keep only as much as the student needs.
				stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
			});
			// The process is already running, so the response is on its way;
			// a late failure ends the stream rather than the agent.
			child.on("error", (error: Error) => {
				request.log.error({ slug, error: error.message }, "project archive failed");
				child.stdout.destroy(new Error("zip failed"));
			});
			child.on("close", (code) => {
				if (code !== 0) {
					request.log.error({ slug, code, stderr }, "project archive failed");
					child.stdout.destroy(new Error("zip failed"));
				}
			});
			return reply.type("application/zip").send(child.stdout);
		});

		registerGitRoutes(instance, { homeDir: options.homeDir });
		instance.register(checksRoute, { homeDir: options.homeDir });
		instance.register(listeningRoutes, { monitor, forwards });
		instance.register(eventsRoute, {
			homeDir: options.homeDir,
			maxSockets: options.maxEventSockets,
			watchers,
		});

		instance.get(
			"/terminals/:terminalId/attach",
			{ websocket: true },
			async (socket: WebSocket, request) => {
				// Attaching is asynchronous, so hold incoming frames until the
				// PTY and its listeners exist; otherwise early input is lost.
				socket.pause();
				const params = IdParam.safeParse(request.params);
				const query = AttachQuery.safeParse(request.query ?? {});
				if (!params.success || !query.success) {
					socket.resume();
					socket.send(JSON.stringify({ type: "error", code: "TERMINAL_NOT_FOUND" }));
					socket.close(1008, "invalid attach request");
					return;
				}
				const { terminalId } = params.data;
				try {
					await registry.attach(terminalId, socket, query.data);
					socket.resume();
					request.log.debug(
						{ terminalId, cols: query.data.cols, rows: query.data.rows },
						"terminal attached",
					);
				} catch (error) {
					const code = error instanceof AgentFailure ? error.code : "TMUX_FAILED";
					socket.resume();
					socket.send(JSON.stringify({ type: "error", code }));
					socket.close(1008, code);
				}
			},
		);
	});

	return app;
}

/** Strip the quotes an HTTP entity tag is usually sent with. */
function unquote(value: string): string {
	return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}
