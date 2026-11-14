import type { WebSocket } from "@fastify/websocket";
import {
	AgentCreateTerminalRequest,
	AgentSwitchChatRequest,
	MAX_TERMINALS_PER_WORKSPACE,
	TerminalAttachMode,
	TerminalId,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { askHostToSwitch } from "./chat/switch-request.js";
import { CHAT_SOCKET_DIR } from "./chat/wire.js";
import { AgentFailure, sendError } from "./errors.js";
import { recordBaseline } from "./git-baseline.js";
import type { PanePipes } from "./pane-pipes.js";
import { readTerminalsExit, sendText, type TerminalRegistry } from "./terminals.js";
import {
	chatHostCommand,
	closeSession,
	commandForAgent,
	createSession,
	hasSession,
	listSessions,
	respawnChatHost,
	type TmuxServer,
} from "./tmux.js";

const IdParam = z.object({ terminalId: TerminalId });

const AttachQuery = z.object({
	cols: z.coerce.number().int().min(1).max(1000).optional(),
	rows: z.coerce.number().int().min(1).max(1000).optional(),
	// Only live help sets this; no mode is the student's own attach.
	mode: TerminalAttachMode.optional(),
});

interface TerminalsRouteOptions {
	homeDir: string;
	tmuxServer: TmuxServer;
	registry: TerminalRegistry;
	panePipes?: PanePipes;
	terminalsExitPath?: string;
	build?: string;
	/** Where the chat hosts listen; CHAT_SOCKET_DIR unless a test says otherwise. */
	chatSocketDir?: string;
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
							command:
								parsed.data.kind === "chat"
									? chatHostCommand(
											parsed.data.id,
											parsed.data.resumeChatOf,
											parsed.data.agent,
										)
									: commandForAgent(parsed.data.agent),
							institutionalEnv: parsed.data.institutionalEnv,
							recordBaseline,
						}
					: undefined,
			);
			request.log.debug(
				{ terminalId: created.id, session: `pk-${created.id}` },
				"tmux session created",
			);
			await options.panePipes?.start(created.id);
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

	// Swap a chat tab's agent: the running host writes the handoff, then the
	// other agent's host takes its place in the same session (SPEC.md §10.8).
	instance.post("/terminals/:terminalId/chat-agent", async (request, reply) => {
		const params = IdParam.safeParse(request.params);
		const body = AgentSwitchChatRequest.safeParse(request.body);
		if (!params.success || !body.success) {
			return reply.code(400).send({
				error: { code: "BAD_REQUEST", message: "invalid chat agent request" },
			});
		}
		const { terminalId } = params.data;
		try {
			if (!(await hasSession(terminalId, tmuxServer))) {
				throw new AgentFailure("TERMINAL_NOT_FOUND", "no such terminal");
			}
			await askHostToSwitch(
				options.chatSocketDir ?? CHAT_SOCKET_DIR,
				terminalId,
				body.data.agent,
			);
			try {
				await respawnChatHost(
					terminalId,
					body.data.agent,
					body.data.institutionalEnv,
					tmuxServer,
				);
			} catch (error) {
				// The running host stopped serving to be replaced; start the same
				// agent again with its own key, and it drops the unused handoff.
				const previous = body.data.agent === "claude" ? "codex" : "claude";
				await respawnChatHost(
					terminalId,
					previous,
					body.data.previousInstitutionalEnv,
					tmuxServer,
				).catch(() =>
					request.log.warn({ terminalId }, "could not restart the chat's agent"),
				);
				throw error;
			}
			request.log.info({ terminalId, agent: body.data.agent }, "chat agent switched");
			return reply.code(204).send();
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
		// A terminal that already ended may still hold a pipe.
		options.panePipes?.stop(terminalId);
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
					{
						terminalId,
						cols: query.data.cols,
						rows: query.data.rows,
						mode: query.data.mode,
					},
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
