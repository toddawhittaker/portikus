import { requireUser } from "@portikus/auth";
import { ProcessStopErrorCode, ProcessStopRequest } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { AgentCallError } from "../agent-client.js";
import type { ServerDeps } from "../server.js";
import { ownedScope, sendError } from "./project-scope.js";

/** Stops one student may ask for in a minute. Counted in this process (ADR 0010). */
export const PROCESS_STOPS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** The status each agent refusal keeps when passed on. */
const REFUSAL_STATUS: Record<ProcessStopErrorCode, number> = {
	PROCESS_NOT_FOUND: 404,
	PROCESS_CHANGED: 409,
	PROCESS_PROTECTED: 403,
};

/**
 * The student stops one of their own processes (SPEC.md §18.3; docs/EPIC-21.md
 * rulings 13 and 15). Owner-only; the agent checks the PID, its start ticks
 * and the protected list. Neither the log nor the audit row carries a
 * process name or command line (SPEC.md §24.11).
 */
export function registerProcessRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const stopping = new Set<string>();
	const stopTimes = new Map<string, number[]>();

	function overLimit(userId: string): boolean {
		const now = Date.now();
		const recent = (stopTimes.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
		const over = recent.length >= PROCESS_STOPS_PER_MINUTE;
		if (!over) recent.push(now);
		stopTimes.set(userId, recent);
		return over;
	}

	app.post("/workspaces/:id/processes/:pid/stop", async (request, reply) => {
		const user = requireUser(request);
		const { pid: rawPid } = request.params as { pid: string };
		const pid = /^[1-9]\d{0,9}$/.test(rawPid) ? Number(rawPid) : Number.NaN;
		const body = ProcessStopRequest.safeParse(request.body ?? {});
		if (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1 || !body.success) {
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
		if (overLimit(user.id)) {
			request.log.warn(
				{ workspaceId: scope.workspaceId },
				"process stop rate limit reached",
			);
			return sendError(
				reply,
				429,
				"RATE_LIMITED",
				"Too many stops just now. Wait a moment.",
			);
		}
		if (stopping.has(scope.workspaceId)) {
			return sendError(
				reply,
				409,
				"STOP_IN_PROGRESS",
				"A process in this workspace is already being stopped",
			);
		}
		stopping.add(scope.workspaceId);
		let exited: boolean;
		try {
			({ exited } = await scope.agent.stopProcess(pid, body.data));
		} catch (error) {
			const refusal =
				error instanceof AgentCallError
					? ProcessStopErrorCode.safeParse(error.code)
					: null;
			if (refusal?.success) {
				return sendError(
					reply,
					REFUSAL_STATUS[refusal.data],
					refusal.data,
					refusalMessage(refusal.data),
				);
			}
			if (!(error instanceof AgentCallError)) {
				request.log.error({ err: error }, "process stop failed");
			}
			return sendError(reply, 502, "AGENT_UNAVAILABLE", "The workspace did not answer");
		} finally {
			stopping.delete(scope.workspaceId);
		}
		const signal = body.data.force ? "SIGKILL" : "SIGTERM";
		await db
			.insertInto("audit_events")
			.values({
				actor: `user:${user.id}`,
				target: scope.workspaceId,
				action: "workspace.process_stopped",
				result: "ok",
				metadata: JSON.stringify({ pid, signal, exited }),
			})
			.execute();
		return { pid, exited };
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
