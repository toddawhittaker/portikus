import type { WebSocket } from "@fastify/websocket";
import {
	AgentCreateTerminalRequest,
	MAX_TERMINALS_PER_WORKSPACE,
	TerminalId,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentFailure, sendError } from "./errors.js";
import { recordBaseline } from "./git.js";
import { readTerminalsExit, sendText, type TerminalRegistry } from "./terminals.js";
import {
	closeSession,
	commandForAgent,
	createSession,
	hasSession,
	listSessions,
	type TmuxServer,
} from "./tmux.js";

const IdParam = z.object({ terminalId: TerminalId });

const AttachQuery = z.object({
	cols: z.coerce.number().int().min(1).max(1000).optional(),
	rows: z.coerce.number().int().min(1).max(1000).optional(),
});

interface TerminalsRouteOptions {
	homeDir: string;
	tmuxServer: TmuxServer;
	registry: TerminalRegistry;
	terminalsExitPath?: string;
	build?: string;
}

/** The terminal routes and the attach socket (SPEC.md §9.7). */
export async function terminalsRoutes(
	instance: FastifyInstance,
	options: TerminalsRouteOptions,
): Promise<void> {
	const { homeDir, tmuxServer, registry } = options;
	instance.get("/terminals", async (request, reply) => {
		try {
			const sessions = await listSessions(tmuxServer);
			return {
				terminals: sessions.map((session) => ({
					id: session.id,
					cwd: session.cwd,
					attachments: registry.countAttachments(session.id),
				})),
			};
		} catch (error) {
			return sendError(request, reply, error, "TMUX_FAILED");
		}
	});

	// How the terminals unit last stopped, so the control plane can explain
	// terminals that vanished (SPEC.md §9.7). Registered before the
	// terminal id routes so the path is not read as an id.
	instance.get("/terminals/last-exit", async () => ({
		exit: await readTerminalsExit(options.terminalsExitPath),
	}));

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
			if (await hasSession(parsed.data.id, tmuxServer)) {
				throw new AgentFailure("TERMINAL_EXISTS", "terminal already exists");
			}
			const sessions = await listSessions(tmuxServer);
			if (sessions.length >= MAX_TERMINALS_PER_WORKSPACE) {
				throw new AgentFailure(
					"TERMINAL_LIMIT",
					"this workspace already has the maximum number of terminals",
				);
			}
			const created = await createSession(
				parsed.data.id,
				parsed.data.cwd,
				homeDir,
				parsed.data.theme,
				parsed.data.timezone,
				tmuxServer,
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
			return sendError(request, reply, error, "TMUX_FAILED");
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
			if (!(await hasSession(terminalId, tmuxServer))) {
				throw new AgentFailure("TERMINAL_NOT_FOUND", "no such terminal");
			}
			const { stopped } = await closeSession(terminalId, tmuxServer);
			registry.closeAll(terminalId, 1000, "terminal deleted");
			// Stragglers get their SIGKILL after the grace period, without
			// holding the response (SPEC.md §9.7).
			stopped.catch((error: unknown) => {
				request.log.warn(
					{ terminalId, error: error instanceof Error ? error.message : error },
					"could not stop a closed terminal's processes",
				);
			});
			request.log.debug(
				{ terminalId, session: `pk-${terminalId}` },
				"tmux session killed",
			);
			return reply.code(204).send();
		} catch (error) {
			return sendError(request, reply, error, "TMUX_FAILED");
		}
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
				sendText(socket, { type: "error", code: "TERMINAL_NOT_FOUND" });
				socket.close(1008, "invalid attach request");
				return;
			}
			const { terminalId } = params.data;
			try {
				await registry.attach(terminalId, socket, query.data);
				if (options.build) {
					sendText(socket, { type: "agent", build: options.build });
				}
				socket.resume();
				request.log.debug(
					{ terminalId, cols: query.data.cols, rows: query.data.rows },
					"terminal attached",
				);
			} catch (error) {
				const code = error instanceof AgentFailure ? error.code : "TMUX_FAILED";
				socket.resume();
				sendText(socket, { type: "error", code });
				socket.close(1008, code);
			}
		},
	);
}
