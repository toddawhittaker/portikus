import type { WebSocket } from "@fastify/websocket";
import { loadSession, requireUser } from "@portikus/auth";
import {
	type ApiError,
	CreateTerminalRequest,
	MAX_TERMINALS_PER_WORKSPACE,
	type Terminal,
	type TerminalList,
	TerminalTheme,
	UpdateTerminalRequest,
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
import { toEditorSettings } from "./me.js";
import {
	createPendingWork,
	dropPresence,
	openPresence,
	touchPresence,
	workspaceUpgradeGuard,
} from "./presence.js";
import {
	countProjectPoints,
	MAX_POINTS_PER_PROJECT,
	makeRecoveryPoint,
} from "./recovery.js";
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

/**
 * The largest frame the API accepts from a workspace agent's terminal. The
 * agent's output chunks and its 256 KiB history replay are far smaller; the
 * agent is student-controlled, so without a cap one frame could make the API
 * buffer up to the `ws` default of 100 MiB (SPEC.md §24.1).
 */
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

/** How often a paused pipe checks whether the browser socket has drained. */
const DRAIN_POLL_MS = 50;

/** Input a browser may send before the agent socket is open. */
const MAX_QUEUED_BYTES = 64 * 1024;

/** Longest a new agent session waits for its recovery point (ADR 0020). */
const AGENT_SESSION_POINT_TIMEOUT_MS = 30_000;

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

/** Full object id, SHA-1 or SHA-256. Anything else is not a baseline. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function gitObjectOrNull(value: string | null): string | null {
	if (value !== null && GIT_OBJECT_ID.test(value)) return value;
	return null;
}

/**
 * The one institutional key this agent kind may receive (SPEC.md §10.6).
 * Only a variable this process actually has is forwarded, and only for the
 * launcher that uses it. The value is never stored or logged.
 */
function institutionalEnv(
	agent: "claude" | "codex" | undefined,
): { ANTHROPIC_API_KEY: string } | { OPENAI_API_KEY: string } | undefined {
	if (agent === "claude") {
		const key = process.env.ANTHROPIC_API_KEY;
		if (key) return { ANTHROPIC_API_KEY: key };
	}
	if (agent === "codex") {
		const key = process.env.OPENAI_API_KEY;
		if (key) return { OPENAI_API_KEY: key };
	}
	return undefined;
}

function toTerminal(row: {
	id: string;
	workspace_id: string;
	name: string;
	cwd: string;
	position: number;
	project_id: string | null;
	theme: string;
	agent: string | null;
	baseline_object_id: string | null;
	baseline_head: string | null;
	recovery_point_id: string | null;
	created_at: Date;
	ended_at: Date | null;
}): Terminal {
	const agent = row.agent === "claude" || row.agent === "codex" ? row.agent : null;
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		cwd: row.cwd,
		position: row.position,
		projectId: row.project_id,
		createdAt: row.created_at.toISOString(),
		endedAt: row.ended_at ? row.ended_at.toISOString() : null,
		// A row written before migration 0010, or by hand, reads as dark.
		theme: TerminalTheme.catch("dark").parse(row.theme),
		agent,
		baselineObjectId: gitObjectOrNull(row.baseline_object_id),
		baselineHead: gitObjectOrNull(row.baseline_head),
		recoveryPointId: row.recovery_point_id,
	};
}

/** A default terminal name, which is a number we are free to reassign. */
const DEFAULT_NAME = /^Terminal (\d+)$/;

/**
 * Pick the name for a new terminal in one project (SPEC.md §9.6, §9.7).
 * A terminal created where an ended terminal used to be takes that terminal's
 * chosen name back; otherwise the name is the lowest "Terminal N" no live
 * terminal of the project is using, so a second project also starts at 1.
 */
export function chooseTerminalName(
	rows: Array<{
		name: string;
		project_id: string | null;
		ended_at: Date | null;
		position: number;
		created_at: Date;
	}>,
	projectId: string | null,
): string {
	const inProject = rows.filter((row) => row.project_id === projectId);
	const live = inProject.filter((row) => row.ended_at === null);
	const liveNames = new Set(live.map((row) => row.name));

	const [reusable] = inProject
		.filter(
			(row) =>
				row.ended_at !== null &&
				!liveNames.has(row.name) &&
				!DEFAULT_NAME.test(row.name),
		)
		.sort(
			(a, b) =>
				a.position - b.position || a.created_at.getTime() - b.created_at.getTime(),
		);
	if (reusable) return reusable.name;

	const taken = new Set<number>();
	for (const row of live) {
		const match = DEFAULT_NAME.exec(row.name);
		if (match) taken.add(Number(match[1]));
	}
	let number = 1;
	while (taken.has(number)) number += 1;
	return `Terminal ${number}`;
}

/**
 * The settings a new terminal of this user starts with: the colour scheme
 * (issue #268) and the zone its shell runs in (issue #287). Once the terminal
 * exists, its own row decides the scheme.
 */
async function userTerminalSettings(
	db: Kysely<Database>,
	userId: string,
): Promise<{ terminalTheme: TerminalTheme; timezone: string }> {
	const row = await db
		.selectFrom("users")
		.select("editor_settings")
		.where("id", "=", userId)
		.executeTakeFirst();
	const settings = toEditorSettings(row?.editor_settings);
	return { terminalTheme: settings.terminalTheme, timezone: settings.timezone };
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
		let project: { id: string; slug: string; path: string } | null = null;
		if (body.data.projectId) {
			const row = await db
				.selectFrom("projects")
				.select(["id", "slug", "path"])
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
		const name =
			body.data.name ?? chooseTerminalName(rows, project ? project.id : null);
		const cwd = body.data.cwd ?? project?.path ?? DEFAULT_CWD;
		// A new terminal starts in the scheme the user chose in their settings
		// unless the caller asked for one outright (issues #267, #268), and in
		// the zone they chose (issue #287).
		const settings = await userTerminalSettings(db, user.id);
		const theme = body.data.theme ?? settings.terminalTheme;

		// A coding agent's session gets a recovery point first, so the state
		// before it can be restored (SPEC.md §10.9). It fails open.
		let recoveryPointId: string | null = null;
		if (body.data.agent !== undefined && project) {
			try {
				if ((await countProjectPoints(db, project.id)) >= MAX_POINTS_PER_PROJECT) {
					// Ids only (ADR 0012); the student is not told (docs/archive/epics/EPIC-10.md decisions).
					request.log.warn(
						{ workspaceId: params.data.id, projectId: project.id },
						"agent-session recovery point skipped: point cap",
					);
				} else {
					const point = await makeRecoveryPoint(db, config, agent, {
						workspaceId: params.data.id,
						project,
						reason: "agent-session",
						createdBy: user.id,
						timeoutMs: AGENT_SESSION_POINT_TIMEOUT_MS,
					});
					recoveryPointId = point.id;
				}
			} catch (error) {
				request.log.warn(
					{
						workspaceId: params.data.id,
						projectId: project.id,
						code: error instanceof AgentCallError ? error.code : "INTERNAL",
					},
					"agent-session recovery point failed",
				);
			}
		}

		await db
			.insertInto("terminals")
			.values({
				id,
				workspace_id: params.data.id,
				name,
				cwd,
				position,
				project_id: project ? project.id : null,
				theme,
				agent: body.data.agent ?? null,
				recovery_point_id: recoveryPointId,
			})
			.execute();

		let baselineObjectId: string | null = null;
		let baselineHead: string | null = null;
		try {
			// The API does not choose the CLI. It forwards the launcher kind
			// and, when this process has it, the matching institutional key
			// (SPEC.md §10.2, §10.6, §24.8).
			const keys = institutionalEnv(body.data.agent);
			const created = await agent.createTerminal({
				id,
				cwd,
				theme,
				timezone: settings.timezone,
				...(body.data.agent === undefined ? {} : { agent: body.data.agent }),
				...(keys === undefined ? {} : { institutionalEnv: keys }),
			});
			baselineObjectId = gitObjectOrNull(created.baselineObjectId);
			baselineHead = gitObjectOrNull(created.baselineHead);
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

		const saved = await db
			.updateTable("terminals")
			.set({
				baseline_object_id: baselineObjectId,
				baseline_head: baselineHead,
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirstOrThrow();

		return reply.status(201).send(toTerminal(saved));
	});

	// PATCH /workspaces/:id/terminals/:tid -- display name, colour scheme, or
	// both (SPEC.md §9.6, issue #268). A scheme change repaints the browser;
	// the shell that is already running keeps the COLORFGBG it started with.
	app.patch("/workspaces/:id/terminals/:tid", async (request, reply) => {
		const user = requireUser(request);
		const params = TerminalParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const body = UpdateTerminalRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}

		const workspace = await findWorkspaceOwnedBy(db, params.data.id, user.id);
		if (!workspace) {
			return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
		}

		const updated = await db
			.updateTable("terminals")
			.set({
				...(body.data.name === undefined ? {} : { name: body.data.name }),
				...(body.data.theme === undefined ? {} : { theme: body.data.theme }),
			})
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
			// A HEAD twin would reach the socket handler and crash (issue #402).
			exposeHeadRoute: false,
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

	// Resumes a paused upstream too: a paused socket never reads the agent's
	// close reply, so closing it would hang for ws's 30 s close timeout.
	function cancel(): void {
		if (!drainTimer) return;
		clearInterval(drainTimer);
		drainTimer = null;
		upstream.resume();
	}

	return {
		apply() {
			if (drainTimer) return;
			if (socket.bufferedAmount <= limits.high) return;
			upstream.pause();
			drainTimer = setInterval(() => {
				if (socket.bufferedAmount >= limits.low) return;
				cancel();
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
			maxPayload: MAX_AGENT_FRAME_BYTES,
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
