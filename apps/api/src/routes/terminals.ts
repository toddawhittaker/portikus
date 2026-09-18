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
import type {
	FastifyBaseLogger,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import { z } from "zod";
import { AgentCallError, type AgentClient, agentClientFor } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import {
	createPendingWork,
	dropPresence,
	openPresence,
	touchPresence,
	workspaceUpgradeGuard,
} from "./presence.js";
import { findWorkspaceOwnedBy } from "./workspace-view.js";

const WorkspaceParam = z.object({ id: z.string().uuid() });
const TerminalParam = z.object({ id: z.string().uuid(), tid: z.string().uuid() });

/** Optional project filter on the terminal listing (SPEC.md §7.5). */
const ListQuery = z.object({ projectId: z.string().uuid().optional() });

/** Terminal size a browser may ask for on attach. */
const TerminalSize = z.object({
	cols: z.coerce.number().int().min(1).max(1000).catch(80),
	rows: z.coerce.number().int().min(1).max(1000).catch(24),
});

/** Working directory a terminal gets when the caller does not choose one (SPEC.md §9.4). */
const DEFAULT_CWD = "/home/student/projects";

/** How many ended terminals the listing keeps, newest first (SPEC.md §9.6). */
const MAX_ENDED_LISTED = 20;

/** How often an attached terminal refreshes its presence row (SPEC.md §6.4). */
const PRESENCE_INTERVAL_MS = 15_000;

/** How often an attached terminal re-checks that its session still exists (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 1000;

/** Pause the agent socket once this much output is waiting on the browser socket. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** Resume once the browser socket has drained back below this. */
const LOW_WATER_BYTES = 256 * 1024;

/** How often a paused pipe checks whether the browser socket has drained. */
const DRAIN_POLL_MS = 50;

/** Input a browser may send before the agent socket is open. */
const MAX_QUEUED_BYTES = 64 * 1024;

/** How long the agent socket may take to answer the upgrade. */
const AGENT_HANDSHAKE_TIMEOUT_MS = 5000;

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
	project_id: string | null;
	created_at: Date;
	ended_at: Date | null;
}): Terminal {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		cwd: row.cwd,
		position: row.position,
		projectId: row.project_id,
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
	const { track, drain } = createPendingWork();

	// GET /workspaces/:id/terminals -- durable metadata only, never the agent.
	app.get("/workspaces/:id/terminals", async (request, reply) => {
		const user = requireUser(request);
		const params = WorkspaceParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const filter = ListQuery.safeParse(request.query ?? {});
		if (!filter.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", filter.error.message);
		}
		const projectId = filter.data.projectId;

		let openQuery = listTerminalRows(db, params.data.id).where("ended_at", "is", null);
		if (projectId) openQuery = openQuery.where("project_id", "=", projectId);
		const open = await openQuery.execute();

		// Old terminals are history, not a list that grows without bound.
		let endedQuery = db
			.selectFrom("terminals")
			.selectAll()
			.where("workspace_id", "=", params.data.id)
			.where("ended_at", "is not", null);
		if (projectId) endedQuery = endedQuery.where("project_id", "=", projectId);
		const ended = await endedQuery
			.orderBy("ended_at", "desc")
			.limit(MAX_ENDED_LISTED)
			.execute();

		const rows = [...open, ...ended].sort(
			(a, b) =>
				a.position - b.position || a.created_at.getTime() - b.created_at.getTime(),
		);
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

		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
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

		// A terminal may belong to one project of this workspace (SPEC.md §7.5).
		let project: { id: string; path: string } | null = null;
		if (body.data.projectId) {
			const row = await db
				.selectFrom("projects")
				.select(["id", "path"])
				.where("id", "=", body.data.projectId)
				.where("workspace_id", "=", params.data.id)
				.executeTakeFirst();
			if (!row) {
				return sendError(reply, 404, "PROJECT_NOT_FOUND", "Project not found");
			}
			project = row;
		}

		const position = rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
		const id = crypto.randomUUID();
		const cwd = body.data.cwd ?? project?.path ?? DEFAULT_CWD;

		const created = await db
			.insertInto("terminals")
			.values({
				id,
				workspace_id: params.data.id,
				name: body.data.name ?? `Terminal ${position + 1}`,
				cwd,
				position,
				project_id: project ? project.id : null,
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

		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
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

	// DELETE /workspaces/:id/terminals/:tid -- closing is a user action, so the
	// terminal goes away entirely (SPEC.md §9.3). The "ended" state is for
	// terminals the platform ended, which the worker marks (SPEC.md §9.7).
	app.delete("/workspaces/:id/terminals/:tid", async (request, reply) => {
		const user = requireUser(request);
		const params = TerminalParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}

		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
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

		await db.deleteFrom("terminals").where("id", "=", row.id).execute();

		return reply.status(204).send();
	});

	// GET /workspaces/:id/terminals/:tid/ws -- the browser end of the pipe.
	app.get(
		"/workspaces/:id/terminals/:tid/ws",
		{
			websocket: true,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				async (request, reply) => {
					const params = TerminalParam.safeParse(request.params);
					if (!params.success) {
						return reply
							.status(400)
							.send({ code: "VALIDATION_FAILED", message: params.error.message });
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
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			// Hold incoming frames until the pipe's listeners are attached, so a
			// browser that closes during this setup cannot be missed.
			socket.pause();

			const { id: workspaceId, tid: terminalId } = request.params as {
				id: string;
				tid: string;
			};
			const workspace = request.workspaceRow ?? null;
			const agent = workspace ? agentClientFor(workspace, config.AGENT_PORT) : null;
			if (!agent) {
				socket.close(1011, "agent unavailable");
				socket.resume();
				return;
			}

			const size = TerminalSize.parse(request.query ?? {});
			const connectionId = crypto.randomUUID();
			await openPresence(db, workspaceId, connectionId);

			if (socket.readyState !== socket.OPEN) {
				// The browser gave up while we were writing presence.
				track(
					dropPresence(db, connectionId).catch((error) => {
						request.log.error(
							{ err: error, connectionId },
							"failed to delete workspace connection",
						);
					}),
				);
				socket.resume();
				return;
			}

			track(
				pipeTerminal({
					db,
					socket,
					agent,
					workspaceId,
					terminalId,
					connectionId,
					log: request.log,
					sessionToken: request.sessionToken,
					cols: size.cols,
					rows: size.rows,
				}),
			);
			socket.resume();
		},
	);

	// Epic 5 linkification navigates to the preview route, which lands in
	// Epic 8 (SPEC.md §14.9, §29 Epic 5 scope note).
	app.get("/workspaces/:id/preview/:port/*", async (_request, reply) => {
		return sendError(
			reply,
			501,
			"NOT_IMPLEMENTED",
			"Application preview is not available yet.",
		);
	});

	app.addHook("onClose", drain);
}

/** Close codes a WebSocket peer is allowed to send on. */
export function safeCloseCode(code: number): number {
	if (code === 1000 || (code >= 1001 && code <= 1003)) return code;
	if (code >= 1007 && code <= 1011) return code;
	if (code >= 3000 && code <= 4999) return code;
	return 1000;
}

interface PipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	agent: AgentClient;
	workspaceId: string;
	terminalId: string;
	connectionId: string;
	log: FastifyBaseLogger;
	sessionToken: string | null;
	cols: number;
	rows: number;
}

/**
 * Stop reading the agent socket while the browser socket is backed up, so a
 * runaway process cannot fill the control plane's memory (SPEC.md §9.7).
 * Returns a function that cancels any drain poll still running.
 */
export function pipeBackpressure(
	socket: { bufferedAmount: number },
	upstream: { pause: () => void; resume: () => void },
	limits: { high: number; low: number; pollMs: number } = {
		high: HIGH_WATER_BYTES,
		low: LOW_WATER_BYTES,
		pollMs: DRAIN_POLL_MS,
	},
): { apply: () => void; cancel: () => void } {
	let drainTimer: NodeJS.Timeout | null = null;

	function cancel(): void {
		if (drainTimer) clearInterval(drainTimer);
		drainTimer = null;
	}

	return {
		apply() {
			if (drainTimer) return;
			if (socket.bufferedAmount <= limits.high) return;
			upstream.pause();
			drainTimer = setInterval(() => {
				if (socket.bufferedAmount >= limits.low) return;
				cancel();
				upstream.resume();
			}, limits.pollMs);
		},
		cancel,
	};
}

/**
 * Forward frames between one browser socket and one agent attachment. Frames
 * are carried unchanged in both directions (SPEC.md §9.7).
 */
async function pipeTerminal(options: PipeOptions): Promise<void> {
	const {
		db,
		socket,
		agent,
		workspaceId,
		terminalId,
		connectionId,
		sessionToken,
		log,
	} = options;

	log.debug({ workspaceId, terminalId, connectionId }, "terminal pipe opened");

	const upstream = new WebSocketClient(
		agent.attachUrl(terminalId, options.cols, options.rows),
		{
			headers: { authorization: agent.authHeader() },
			handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
		},
	);

	// Frames can arrive before the agent socket finishes connecting.
	const queued: string[] = [];
	let queuedBytes = 0;
	let closed = false;
	let lastSessionCheck = Date.now();

	const backpressure = pipeBackpressure(socket, upstream);

	const presenceTimer = setInterval(() => {
		void touchPresence(db, connectionId).catch(() => {});
	}, PRESENCE_INTERVAL_MS);

	async function sessionStillValid(): Promise<boolean> {
		lastSessionCheck = Date.now();
		const user = sessionToken ? await loadSession(db, sessionToken) : null;
		if (user) return true;
		socket.close(4401, "session revoked");
		return false;
	}

	const sessionTimer = setInterval(() => {
		void sessionStillValid().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	const done = new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(presenceTimer);
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve();
		}

		socket.on("message", (data: RawData) => {
			const text = data.toString();
			// Revocation must take effect at once, but one check a second is
			// enough for a stream of keystrokes (SPEC.md §5.3).
			if (Date.now() - lastSessionCheck >= SESSION_CHECK_INTERVAL_MS) {
				void sessionStillValid().catch(() => {});
			}
			if (upstream.readyState === WebSocketClient.OPEN) {
				upstream.send(text);
			} else if (upstream.readyState === WebSocketClient.CONNECTING) {
				queuedBytes += Buffer.byteLength(text);
				if (queuedBytes > MAX_QUEUED_BYTES) {
					socket.close(1009, "too much input before the terminal was ready");
					return;
				}
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
			queuedBytes = 0;
		});

		upstream.on("message", (data: RawData, isBinary: boolean) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(isBinary ? toBuffer(data) : data.toString(), { binary: isBinary });
			backpressure.apply();
		});

		upstream.on("close", (code: number, reason: Buffer) => {
			if (socket.readyState === socket.OPEN) {
				socket.close(safeCloseCode(code), reason.toString());
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			// The browser closing first aborts a still-connecting agent socket,
			// which is the normal path and not a failure.
			const line = { err: error, workspaceId, terminalId, connectionId };
			if (closed) log.info(line, "terminal agent socket failed");
			else log.error(line, "terminal agent socket failed");
			if (socket.readyState === socket.OPEN) {
				socket.close(1011, "agent unavailable");
			}
			finish();
		});
	});

	await done;
	log.debug({ workspaceId, terminalId, connectionId }, "terminal pipe closed");
	try {
		await dropPresence(db, connectionId);
	} catch (error) {
		log.error({ err: error, connectionId }, "failed to delete workspace connection");
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
