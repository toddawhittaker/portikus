import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import { CheckId, CheckRun, ChecksResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import WebSocketClient, { type RawData } from "ws";
import {
	AGENT_TIMEOUT_MS,
	type AgentClient,
	readAgentError,
	readJson,
} from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { createPendingWork, workspaceUpgradeGuard } from "./presence.js";
import {
	agentUrl,
	type ProjectScope,
	scopedProject,
	sendAgentError,
	sendError,
} from "./project-scope.js";
import { pipeBackpressure, safeCloseCode } from "./terminals.js";

/** How often an open output socket re-checks its session (SPEC.md §5.3). */
const SESSION_CHECK_INTERVAL_MS = 1000;

/** How long the agent socket may take to answer the upgrade. */
const AGENT_HANDSHAKE_TIMEOUT_MS = 5000;

/** The largest frame the control plane accepts from a workspace agent. */
const MAX_AGENT_FRAME_BYTES = 1024 * 1024;

/** A run may take a while to start, but starting it is not itself slow. */
const CHECK_BUDGET_MS = AGENT_TIMEOUT_MS;

declare module "fastify" {
	interface FastifyRequest {
		/** The project the check output guard already loaded and authorized. */
		checkScope?: ProjectScope;
	}
}

/** The check id from the route, or null after answering 400. */
function checkIdOf(request: FastifyRequest): string | null {
	const raw = (request.params as { checkId?: unknown }).checkId;
	const parsed = CheckId.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Project checks, brokered for the browser (SPEC.md §18.1). Every route goes
 * through the same ownership gate as the other project routes: the browser
 * never reaches the workspace agent, and the agent is only called once the
 * caller has been shown to own the workspace and the project
 * (SPEC.md §5.2, §24.6).
 */
export function registerCheckRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const { track, drain } = createPendingWork();

	// The configured checks of one project, plus what each last did.
	app.get("/workspaces/:id/projects/:pid/checks", async (request, reply) => {
		const scope = await scopedProject(db, config, request, reply);
		if (!scope) return;
		let response: Response;
		try {
			response = await scope.agent.fetchRaw("GET", agentUrl(scope.slug, "checks"), {
				signal: AbortSignal.timeout(CHECK_BUDGET_MS),
			});
		} catch (error) {
			return sendAgentError(reply, error);
		}
		if (!response.ok) return sendAgentError(reply, await readAgentError(response));
		const parsed = ChecksResponse.safeParse(await readJson(response));
		if (!parsed.success) {
			// The definitions are student content and never reach a log.
			request.log.error(
				{ issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
				"the workspace agent sent checks the contract rejected",
			);
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent sent an answer we could not read.",
			);
		}
		return parsed.data;
	});

	// Start one check.
	app.post(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs",
		async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const checkId = checkIdOf(request);
			if (!checkId) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that is not a check id");
			}
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"POST",
					agentUrl(scope.slug, `checks/${checkId}/runs`),
					{ signal: AbortSignal.timeout(CHECK_BUDGET_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return sendAgentError(reply, await readAgentError(response));
			const parsed = CheckRun.safeParse(await readJson(response));
			if (!parsed.success) {
				return sendError(
					reply,
					503,
					"AGENT_UNAVAILABLE",
					"The workspace agent sent an answer we could not read.",
				);
			}
			return reply.code(201).send(parsed.data);
		},
	);

	// Stop the run that is going now.
	app.delete(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs/current",
		async (request, reply) => {
			const scope = await scopedProject(db, config, request, reply);
			if (!scope) return;
			const checkId = checkIdOf(request);
			if (!checkId) {
				return sendError(reply, 400, "VALIDATION_FAILED", "that is not a check id");
			}
			let response: Response;
			try {
				response = await scope.agent.fetchRaw(
					"DELETE",
					agentUrl(scope.slug, `checks/${checkId}/runs/current`),
					{ signal: AbortSignal.timeout(CHECK_BUDGET_MS) },
				);
			} catch (error) {
				return sendAgentError(reply, error);
			}
			if (!response.ok) return sendAgentError(reply, await readAgentError(response));
			return reply.code(204).send();
		},
	);

	// The output of the current run, replayed then streamed. Nothing travels
	// the other way: a check panel is read-only (SPEC.md §18.1).
	app.get(
		"/workspaces/:id/projects/:pid/checks/:checkId/runs/current",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash (issue #402).
			exposeHeadRoute: false,
			preHandler: [
				workspaceUpgradeGuard(db, config, { ownerOnly: true }),
				async (request, reply) => {
					const scope = await scopedProject(db, config, request, reply);
					if (!scope) return reply;
					request.checkScope = scope;
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			socket.pause();
			const scope = request.checkScope;
			const checkId = checkIdOf(request);
			if (!scope || !checkId) {
				socket.close(1008, "invalid check");
				socket.resume();
				return;
			}
			track(
				pipeOutput({
					db,
					socket,
					agent: scope.agent,
					slug: scope.slug,
					checkId,
					workspaceId: scope.workspaceId,
					log: request.log,
					sessionToken: request.sessionToken,
				}),
			);
			socket.resume();
		},
	);

	app.addHook("onClose", drain);
}

interface PipeOptions {
	db: Kysely<Database>;
	socket: WebSocket;
	agent: AgentClient;
	slug: string;
	checkId: string;
	workspaceId: string;
	log: FastifyBaseLogger;
	sessionToken: string | null;
}

/** Forward output frames from one agent socket to one browser socket. */
async function pipeOutput(options: PipeOptions): Promise<void> {
	const { db, socket, agent, slug, checkId, workspaceId, sessionToken, log } = options;

	const upstream = new WebSocketClient(agent.checkOutputUrl(slug, checkId), {
		headers: { authorization: agent.authHeader() },
		handshakeTimeout: AGENT_HANDSHAKE_TIMEOUT_MS,
		maxPayload: MAX_AGENT_FRAME_BYTES,
	});

	let closed = false;
	const backpressure = pipeBackpressure(socket, upstream);

	const sessionTimer = setInterval(() => {
		void (async () => {
			const user = sessionToken ? await loadSession(db, sessionToken) : null;
			if (!user || sessionGate(user)) socket.close(4401, "session revoked");
		})().catch(() => {});
	}, SESSION_CHECK_INTERVAL_MS);

	await new Promise<void>((resolve) => {
		function finish(): void {
			if (closed) return;
			closed = true;
			clearInterval(sessionTimer);
			backpressure.cancel();
			resolve();
		}

		// Nothing the browser sends is forwarded; this socket is one-way.
		socket.on("message", () => {});

		socket.on("close", (code: number) => {
			if (
				upstream.readyState === WebSocketClient.OPEN ||
				upstream.readyState === WebSocketClient.CONNECTING
			) {
				upstream.close(safeCloseCode(code), "browser closed");
			}
			finish();
		});

		socket.on("error", () => finish());

		upstream.on("message", (data: RawData) => {
			if (socket.readyState !== socket.OPEN) return;
			socket.send(data.toString());
			backpressure.apply();
		});

		// The agent's own reason bytes are never relayed: the browser is told
		// only that the run's socket ended (SPEC.md §24.1).
		upstream.on("close", (code: number) => {
			if (socket.readyState === socket.OPEN) {
				socket.close(safeCloseCode(code), "run finished");
			}
			finish();
		});

		upstream.on("error", (error: Error) => {
			// The slug is a student-chosen name, so it stays out of the log.
			const line = { err: error, workspaceId };
			if (closed) log.info(line, "check output agent socket failed");
			else log.error(line, "check output agent socket failed");
			if (socket.readyState === socket.OPEN) socket.close(1011, "agent unavailable");
			finish();
		});
	});
}
