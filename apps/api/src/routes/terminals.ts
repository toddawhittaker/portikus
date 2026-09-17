import type { WebSocket } from "@fastify/websocket";
import { loadSession, requireUser } from "@portikus/auth";
import {
	type ApiError,
	CreateTerminalRequest,
	MAX_TERMINALS_PER_WORKSPACE,
	RenameTerminalRequest,
	type Terminal,
	type TerminalList,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import { z } from "zod";
import { AgentCallError, type AgentClient, agentClientFor } from "../agent-client.js";
import { log } from "../log.js";
import type { ServerDeps } from "../server.js";
import { dropPresence, openPresence, touchPresence } from "./presence.js";
import { countActive, findOwnedWorkspace } from "./workspace-view.js";

const WorkspaceParam = z.object({ id: z.string().uuid() });
const TerminalParam = z.object({ id: z.string().uuid(), tid: z.string().uuid() });

/** Working directory a terminal gets when the caller does not choose one (SPEC.md §9.4). */
const DEFAULT_CWD = "/home/student/projects";

/** Concurrent sockets allowed per workspace, the same cap the presence socket uses. */
const MAX_CONNECTIONS_PER_WORKSPACE = 16;

/** How often an attached terminal refreshes its presence row (SPEC.md §6.4). */
const PRESENCE_INTERVAL_MS = 15_000;

/** How often an attached terminal re-checks that its session still exists (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 30_000;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function sendError(
	reply: FastifyReply,
	statusCode: number,
	code: ApiError["code"],
	message: string,
): void {
	reply.status(statusCode).send({ code, message });
}

function toTerminal(row: {
	id: string;
	workspace_id: string;
	name: string;
	cwd: string;
	position: number;
	created_at: Date;
	ended_at: Date | null;
}): Terminal {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		cwd: row.cwd,
		position: row.position,
		createdAt: row.created_at.toISOString(),
		endedAt: row.ended_at ? row.ended_at.toISOString() : null,
	};
}

function listTerminalRows(db: Kysely<Database>, workspaceId: string) {
	return db
		.selectFrom("terminals")
		.selectAll()
		.where("workspace_id", "=", workspaceId)
		.orderBy("position")
		.orderBy("created_at");
}

/**
 * Terminal metadata and the browser end of the terminal transport
 * (SPEC.md §9.3, §9.6, §9.7; ADR 0009). The API is a byte pipe: it forwards
 * frames between the browser and the workspace agent without reading them.
 */
export function registerTerminalRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	// Work started by a socket outlives the request that caused it, so shutdown
	// has to drain it before the database pool closes.
	const pending = new Set<Promise<unknown>>();
	function track(work: Promise<unknown>): void {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	}

	// GET /workspaces/:id/terminals -- durable metadata only, never the agent.
	app.get("/workspaces/:id/terminals", async (request, reply) => {
		const user = requireUser(request);
		const params = WorkspaceParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const workspace = await findOwnedWorkspace(db, user, params.data.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const rows = await listTerminalRows(db, params.data.id).execute();
		const body: TerminalList = { terminals: rows.map(toTerminal) };
		return body;
	});

	// POST /workspaces/:id/terminals
	app.post("/workspaces/:id/terminals", async (request, reply) => {
		const user = requireUser(request);
		const params = WorkspaceParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const body = CreateTerminalRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const workspace = await findOwnedWorkspace(db, user, params.data.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const agent = agentClientFor(workspace, config.AGENT_PORT);
		if (workspace.state !== "running" || !agent) {
			return sendError(
				reply,
				409,
				"AGENT_UNAVAILABLE",
				"The workspace is not running yet. Start it and try again.",
			);
		}

		const rows = await listTerminalRows(db, params.data.id).execute();
		const open = rows.filter((row) => row.ended_at === null);
		if (open.length >= MAX_TERMINALS_PER_WORKSPACE) {
			return sendError(
				reply,
				409,
				"TERMINAL_LIMIT",
				`A workspace may have at most ${MAX_TERMINALS_PER_WORKSPACE} terminals open.`,
			);
		}

		const position = rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
		const id = crypto.randomUUID();
		const cwd = body.data.cwd ?? DEFAULT_CWD;

		const created = await db
			.insertInto("terminals")
			.values({
				id,
				workspace_id: params.data.id,
				name: body.data.name ?? `Terminal ${position + 1}`,
				cwd,
				position,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		try {
			await agent.createTerminal({ id, cwd });
		} catch (error) {
			// The row only means something if the agent has the tmux session.
			await db.deleteFrom("terminals").where("id", "=", id).execute();
			if (error instanceof AgentCallError && error.code === "INVALID_CWD") {
				return sendError(reply, 400, "VALIDATION_FAILED", error.message);
			}
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent could not create the terminal.",
			);
		}

		return reply.status(201).send(toTerminal(created));
	});

	// PATCH /workspaces/:id/terminals/:tid -- display name only (SPEC.md §9.6).
	app.patch("/workspaces/:id/terminals/:tid", async (request, reply) => {
		const user = requireUser(request);
		const params = TerminalParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const body = RenameTerminalRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const workspace = await findOwnedWorkspace(db, user, params.data.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const updated = await db
			.updateTable("terminals")
			.set({ name: body.data.name })
			.where("id", "=", params.data.tid)
			.where("workspace_id", "=", params.data.id)
			.returningAll()
			.executeTakeFirst();
		if (!updated) {
			return sendError(reply, 404, "TERMINAL_NOT_FOUND", "Terminal not found");
		}
		return toTerminal(updated);
	});

	// DELETE /workspaces/:id/terminals/:tid
	app.delete("/workspaces/:id/terminals/:tid", async (request, reply) => {
		const user = requireUser(request);
		const params = TerminalParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const workspace = await findOwnedWorkspace(db, user, params.data.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const row = await db
			.selectFrom("terminals")
			.selectAll()
			.where("id", "=", params.data.tid)
			.where("workspace_id", "=", params.data.id)
			.executeTakeFirst();
		if (!row) {
			return sendError(reply, 404, "TERMINAL_NOT_FOUND", "Terminal not found");
		}

		const agent = agentClientFor(workspace, config.AGENT_PORT);
		if (agent && row.ended_at === null) {
			try {
				await agent.deleteTerminal(row.id);
			} catch (error) {
				// A session the agent has already lost is still a closed terminal.
				const gone =
					error instanceof AgentCallError &&
					(error.code === "TERMINAL_NOT_FOUND" || error.code === "AGENT_UNAVAILABLE");
				if (!gone) throw error;
			}
		}

		await db
			.updateTable("terminals")
			.set({ ended_at: new Date().toISOString() })
			.where("id", "=", row.id)
			.where("ended_at", "is", null)
			.execute();

		return reply.status(204).send();
	});

	// GET /workspaces/:id/terminals/:tid/ws -- the browser end of the pipe.
	app.get(
		"/workspaces/:id/terminals/:tid/ws",
		{
			websocket: true,
			preHandler: async (request, reply) => {
				const user = requireUser(request);
				const params = TerminalParam.safeParse(request.params);
				if (!params.success) {
					return reply
						.status(400)
						.send({ code: "VALIDATION_FAILED", message: params.error.message });
				}
				const workspace = await findOwnedWorkspace(db, user, params.data.id);
				if (!workspace) {
					return reply
						.status(404)
						.send({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" });
				}
				const active = await countActive(db, params.data.id, config);
				if (active >= MAX_CONNECTIONS_PER_WORKSPACE) {
					return reply.status(429).send({
						code: "TOO_MANY_CONNECTIONS",
						message: "This workspace already has too many open connections",
					});
				}
				const terminal = await db
					.selectFrom("terminals")
					.selectAll()
					.where("id", "=", params.data.tid)
					.where("workspace_id", "=", params.data.id)
					.where("ended_at", "is", null)
					.executeTakeFirst();
				if (!terminal) {
					return reply
						.status(404)
						.send({ code: "TERMINAL_NOT_FOUND", message: "Terminal not found" });
				}
			},
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			const { id: workspaceId, tid: terminalId } = request.params as {
				id: string;
				tid: string;
			};
			const workspace = await db
				.selectFrom("workspaces")
				.selectAll()
				.where("id", "=", workspaceId)
				.executeTakeFirst();
			const agent = workspace
				? agentClientFor(workspace as Record<string, unknown>, config.AGENT_PORT)
				: null;
			if (!agent) {
				socket.close(1011, "agent unavailable");
				return;
			}

			const size = sizeFrom(request.query);
			const connectionId = crypto.randomUUID();
			await openPresence(db, workspaceId, connectionId);

			track(
				pipeTerminal({
					db,
					socket,
					agent,
					terminalId,
					connectionId,
					sessionToken: request.sessionToken,
					cols: size.cols,
					rows: size.rows,
				}),
			);
		},
	);

	// Epic 5 linkification navigates here; the real routes land in Epics 7 and 8
	// (SPEC.md §14.9, §29 Epic 5 scope note).
	app.get("/workspaces/:id/files", async (_request, reply) => {
		return sendError(
			reply,
			501,
			"NOT_IMPLEMENTED",
			"The file browser is not available yet.",
		);
	});

	app.get("/workspaces/:id/preview/:port/*", async (_request, reply) => {
		return sendError(
			reply,
			501,
			"NOT_IMPLEMENTED",
			"Application preview is not available yet.",
		);
	});

	app.addHook("onClose", async () => {
		while (pending.size > 0) {
			await Promise.allSettled([...pending]);
		}
	});
}

function sizeFrom(query: unknown): { cols: number; rows: number } {
	const raw = (query ?? {}) as Record<string, unknown>;
	const cols = Number(raw.cols);
	const rows = Number(raw.rows);
	return {
		cols: Number.isInteger(cols) && cols > 0 && cols <= 1000 ? cols : DEFAULT_COLS,
		rows: Number.isInteger(rows) && rows > 0 && rows <= 1000 ? rows : DEFAULT_ROWS,
	};
}

/** Close codes a WebSocket peer is allowed to send on. */
function safeCloseCode(code: number): number {
	if (code === 1000 || (code >= 1001 && code <= 1003)) return code;
	if (code >= 1007 && code <= 1011) return code;
	if (code >= 3000 && code <= 4999) return code;
	return 1000;
}

interface PipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	agent: AgentClient;
	terminalId: string;
	connectionId: string;
	sessionToken: string | null;
	cols: number;
	rows: number;
}

/**
 * Forward frames between one browser socket and one agent attachment. Frames
 * are carried unchanged in both directions (SPEC.md §9.7).
 */
async function pipeTerminal(options: PipeOptions): Promise<void> {
	const { db, socket, agent, terminalId, connectionId, sessionToken } = options;

	const upstream = new WebSocketClient(
		agent.attachUrl(terminalId, options.cols, options.rows),
		{ headers: { authorization: agent.authHeader() } },
	);

	// Frames can arrive before the agent socket finishes connecting.
	const queued: string[] = [];
	let closed = false;

	const presenceTimer = setInterval(() => {
		void touchPresence(db, connectionId).catch(() => {});
	}, PRESENCE_INTERVAL_MS);

	const sessionTimer = setInterval(() => {
		void (async () => {
			const user = sessionToken ? await loadSession(db, sessionToken) : null;
			if (!user) socket.close(4401, "session revoked");
		})().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	const done = new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(presenceTimer);
			clearInterval(sessionTimer);
			resolve();
		}

		socket.on("message", (data: RawData) => {
			const text = data.toString();
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.send(text);
			} else if (upstream.readyState === WebSocketClient.CONNECTING) {
				queued.push(text);
			}
		});

		socket.on("close", (code: number, reason: Buffer) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), reason.toString());
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("open", () => {
			for (const frame of queued.splice(0)) upstream.send(frame);
		});

		upstream.on("message", (data: RawData, isBinary: boolean) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(isBinary ? toBuffer(data) : data.toString(), { binary: isBinary });
		});

		upstream.on("close", (code: number, reason: Buffer) => {
			if (socket.readyState === socket.OPEN) {
				socket.close(safeCloseCode(code), reason.toString());
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			log("error", {
				msg: "terminal agent socket failed",
				terminalId,
				error: error.message,
			});
			if (socket.readyState === socket.OPEN) {
				socket.close(1011, "agent unavailable");
			}
			finish();
		});
	});

	await done;
	try {
		await dropPresence(db, connectionId);
	} catch (error) {
		log("error", {
			msg: "failed to delete workspace connection",
			connectionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
