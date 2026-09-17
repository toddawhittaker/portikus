import websocket, { type WebSocket } from "@fastify/websocket";
import {
	AgentCreateProjectRequest,
	AgentCreateTerminalRequest,
	AgentDuplicateProjectRequest,
	type AgentErrorCode,
	AgentRenameProjectRequest,
	MAX_TERMINALS_PER_WORKSPACE,
	TerminalId,
} from "@portikus/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { tokenAuth } from "./auth.js";
import { log } from "./log.js";
import {
	type ArchiveProcess,
	archiveProject,
	createProject,
	duplicateProject,
	getProject,
	gitInitProject,
	listProjects,
	renameProject,
} from "./projects.js";
import { TerminalRegistry } from "./terminals.js";
import {
	AgentFailure,
	createSession,
	hasSession,
	killSession,
	listSessions,
} from "./tmux.js";

const ERROR_STATUS: Record<AgentErrorCode, number> = {
	UNAUTHORIZED: 401,
	TERMINAL_NOT_FOUND: 404,
	TERMINAL_EXISTS: 409,
	TERMINAL_LIMIT: 409,
	ATTACHMENT_LIMIT: 409,
	INVALID_CWD: 400,
	TMUX_FAILED: 500,
	PROJECT_EXISTS: 409,
	PROJECT_NOT_FOUND: 404,
	INVALID_SLUG: 400,
	INVALID_URL: 400,
	GIT_FAILED: 500,
};

const IdParam = z.object({ terminalId: TerminalId });

const AttachQuery = z.object({
	cols: z.coerce.number().int().min(1).max(1000).optional(),
	rows: z.coerce.number().int().min(1).max(1000).optional(),
});

export interface ServerOptions {
	tokenPath: string;
	homeDir: string;
	tmuxSocketName?: string;
}

/** The workspace agent's HTTP and WebSocket surface (SPEC.md §9.7). */
export function buildServer(options: ServerOptions): FastifyInstance {
	const app = Fastify({ logger: false });
	const registry = new TerminalRegistry(options.homeDir, options.tmuxSocketName);

	// Registered before @fastify/websocket's own preClose so attachments get a
	// close code before that plugin drops the sockets.
	app.addHook("preClose", async () => {
		registry.closeEverything();
	});

	// A terminal input frame is small; refuse anything far past that before it
	// is buffered (SPEC.md §9.7).
	app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

	// Every route, the upgrade included, needs the token (SPEC.md §23.5).
	app.addHook("preHandler", tokenAuth(options.tokenPath));

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

		instance.get("/terminals", async (_request, reply) => {
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
				return sendError(reply, error);
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
					options.tmuxSocketName,
				);
				log("info", { msg: "terminal created", terminalId: created.id });
				return reply
					.code(201)
					.send({ id: created.id, cwd: created.cwd, attachments: 0 });
			} catch (error) {
				return sendError(reply, error);
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
				log("info", { msg: "terminal deleted", terminalId });
				return reply.code(204).send();
			} catch (error) {
				return sendError(reply, error);
			}
		});

		instance.get("/projects", async (_request, reply) => {
			try {
				return { projects: await listProjects(options.homeDir) };
			} catch (error) {
				return sendError(reply, error);
			}
		});

		instance.get("/projects/:slug", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				return await getProject(slug, options.homeDir);
			} catch (error) {
				return sendError(reply, error);
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
				log("info", {
					msg: "project created",
					slug: project.slug,
					source: parsed.data.source,
				});
				return reply.code(201).send(project);
			} catch (error) {
				return sendError(reply, error);
			}
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
				log("info", { msg: "project renamed", slug, to: project.slug });
				return project;
			} catch (error) {
				return sendError(reply, error);
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
				log("info", { msg: "project duplicated", slug, to: project.slug });
				return project;
			} catch (error) {
				return sendError(reply, error);
			}
		});

		instance.post("/projects/:slug/git-init", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			try {
				const project = await gitInitProject(slug, options.homeDir);
				log("info", { msg: "project git initialized", slug });
				return project;
			} catch (error) {
				return sendError(reply, error);
			}
		});

		instance.get("/projects/:slug/archive", async (request, reply) => {
			const { slug } = request.params as { slug: string };
			let child: ArchiveProcess;
			try {
				child = await archiveProject(slug, options.homeDir);
			} catch (error) {
				return sendError(reply, error);
			}
			log("info", { msg: "project archive streamed", slug });
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				if (code !== 0) {
					log("error", { msg: "project archive failed", slug, code, stderr });
					child.stdout.destroy(new Error("zip failed"));
				}
			});
			return reply.type("application/zip").send(child.stdout);
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
					log("info", { msg: "terminal attached", terminalId });
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

function sendError(reply: FastifyReply, error: unknown) {
	if (error instanceof AgentFailure) {
		return reply
			.code(ERROR_STATUS[error.code])
			.send({ error: { code: error.code, message: error.message } });
	}
	log("error", {
		msg: "agent request failed",
		error: error instanceof Error ? error.message : String(error),
	});
	return reply.code(500).send({
		error: { code: "TMUX_FAILED", message: "internal error" },
	});
}
