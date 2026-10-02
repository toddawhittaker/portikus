import { requireUser } from "@portikus/auth";
import { ProcessStopErrorCode, ProcessStopRequest } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import { sendError } from "../http.js";
import { check, createCounter } from "../rate-limit.js";
import type { ServerDeps } from "../server.js";
import { ownedScope } from "./project-scope.js";

/** Stops one person may ask for in a minute. Counted in this process (ADR 0010). */
export const PROCESS_STOPS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** The status each agent refusal keeps when passed on. */
const REFUSAL_STATUS: Record<ProcessStopErrorCode, number> = {
	PROCESS_NOT_FOUND: 404,
	PROCESS_CHANGED: 409,
	PROCESS_PROTECTED: 403,
};

// Shared by the student's and the administrator's stop, so "one stop at a
// time per workspace" (SPEC.md §18.3) holds across both.
const stopping = new Set<string>();
const stops = createCounter(PROCESS_STOPS_PER_MINUTE, WINDOW_MS);

function overLimit(actorId: string): boolean {
	return !check(stops, actorId).allowed;
}

/** The pid from the path and the body, or null when either is invalid. */
export function parseStop(
	rawPid: string,
	rawBody: unknown,
): { pid: number; body: ProcessStopRequest } | null {
	const pid = /^[1-9]\d{0,9}$/.test(rawPid) ? Number(rawPid) : Number.NaN;
	const body = ProcessStopRequest.safeParse(rawBody ?? {});
	if (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1 || !body.success) return null;
	return { pid, body: body.data };
}

/**
 * Sends one stop through the agent's checked route and writes the audit row
 * (SPEC.md §18.3, §24.11). `onExited` runs in the audit row's transaction
 * only when the process really exited. Nothing here names the process.
 */
export async function stopThroughAgent(opts: {
	db: Kysely<Database>;
	agent: AgentClient;
	workspaceId: string;
	actorId: string;
	pid: number;
	body: ProcessStopRequest;
	reply: FastifyReply;
	log: FastifyBaseLogger;
	onExited?: (trx: Kysely<Database>) => Promise<unknown>;
}): Promise<{ pid: number; exited: boolean } | undefined> {
	const { db, agent, workspaceId, actorId, pid, body, reply, log } = opts;
	if (overLimit(actorId)) {
		log.warn({ workspaceId }, "process stop rate limit reached");
		sendError(reply, 429, "RATE_LIMITED", "Too many stops just now. Wait a moment.");
		return undefined;
	}
	if (stopping.has(workspaceId)) {
		sendError(
			reply,
			409,
			"STOP_IN_PROGRESS",
			"A process in this workspace is already being stopped",
		);
		return undefined;
	}
	stopping.add(workspaceId);
	let exited: boolean;
	try {
		({ exited } = await agent.stopProcess(pid, body));
	} catch (error) {
		const refusal =
			error instanceof AgentCallError
				? ProcessStopErrorCode.safeParse(error.code)
				: null;
		if (refusal?.success) {
			sendError(
				reply,
				REFUSAL_STATUS[refusal.data],
				refusal.data,
				refusalMessage(refusal.data),
			);
			return undefined;
		}
		if (!(error instanceof AgentCallError)) {
			log.error({ err: error }, "process stop failed");
		}
		sendError(reply, 502, "AGENT_UNAVAILABLE", "The workspace did not answer");
		return undefined;
	} finally {
		stopping.delete(workspaceId);
	}
	const signal = body.force ? "SIGKILL" : "SIGTERM";
	await db.transaction().execute(async (trx) => {
		await recordAudit(trx, {
			actor: `user:${actorId}`,
			target: workspaceId,
			action: "workspace.process_stopped",
			result: "ok",
			metadata: { pid, signal, exited },
		});
		if (exited && opts.onExited) await opts.onExited(trx);
	});
	return { pid, exited };
}

/**
 * The student stops one of their own processes (SPEC.md §18.3). Owner-only; the
 * agent checks the PID, its start ticks
 * and the protected list.
 */
export function registerProcessRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;

	app.post("/workspaces/:id/processes/:pid/stop", async (request, reply) => {
		const user = requireUser(request);
		const parsed = parseStop((request.params as { pid: string }).pid, request.body);
		if (!parsed) {
			return sendError(reply, 400, "VALIDATION_FAILED", "invalid process id or body");
		}
		const scope = await ownedScope(db, config, request, reply);
		if (!scope) return;
		if (!scope.running) {
			return sendError(
				reply,
				409,
				"WORKSPACE_NOT_RUNNING",
				"The workspace is not running",
			);
		}
		if (!scope.agent) {
			return sendError(
				reply,
				503,
				"AGENT_UNAVAILABLE",
				"The workspace agent is not reachable.",
			);
		}
		return stopThroughAgent({
			db,
			agent: scope.agent,
			workspaceId: scope.workspaceId,
			actorId: user.id,
			pid: parsed.pid,
			body: parsed.body,
			reply,
			log: request.log,
		});
	});
}

/** Our own wording, so nothing the agent wrote reaches the browser. */
function refusalMessage(code: ProcessStopErrorCode): string {
	switch (code) {
		case "PROCESS_NOT_FOUND":
			return "That process has already stopped.";
		case "PROCESS_CHANGED":
			return "That process ID now belongs to a different program.";
		case "PROCESS_PROTECTED":
			return "This process cannot be stopped here.";
	}
}
