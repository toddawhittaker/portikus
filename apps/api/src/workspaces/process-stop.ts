import { ProcessStopErrorCode, ProcessStopRequest } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { ZodType } from "zod";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import { sendError } from "../http.js";
import { check, createCounter } from "../rate-limit.js";

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
// time per workspace" (SPEC.md §18.3) holds across both. Monitor's tree
// stop and "Lower priority" count against the same lock and limit.
const stopping = new Set<string>();
const stops = createCounter(PROCESS_STOPS_PER_MINUTE, WINDOW_MS);

function overLimit(actorId: string): boolean {
	return !check(stops, actorId).allowed;
}

/** The pid from the path and the body, or null when either is invalid. */
export function parseProcessTarget<T>(
	rawPid: string,
	rawBody: unknown,
	schema: ZodType<T>,
): { pid: number; body: T } | null {
	const pid = /^[1-9]\d{0,9}$/.test(rawPid) ? Number(rawPid) : Number.NaN;
	const body = schema.safeParse(rawBody ?? {});
	if (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1 || !body.success) return null;
	return { pid, body: body.data };
}

/** The pid from the path and a single stop's body, or null when either is invalid. */
export function parseStop(
	rawPid: string,
	rawBody: unknown,
): { pid: number; body: ProcessStopRequest } | null {
	return parseProcessTarget(rawPid, rawBody, ProcessStopRequest);
}

/** What one process action writes to the audit log. Never the process's name. */
export interface ProcessAudit {
	action: string;
	metadata: Record<string, unknown>;
}

/**
 * Sends one process action through the agent's checked routes and writes the
 * audit row (SPEC.md §18.3, §24.11): the rate limit, one action per workspace
 * at a time, and the agent's refusals in our own words. `after` runs in the
 * audit row's transaction.
 */
export async function actThroughAgent<T>(opts: {
	db: Kysely<Database>;
	workspaceId: string;
	actorId: string;
	reply: FastifyReply;
	log: FastifyBaseLogger;
	call: () => Promise<T>;
	audit: (answer: T) => ProcessAudit;
	after?: (trx: Kysely<Database>, answer: T) => Promise<unknown>;
}): Promise<T | undefined> {
	const { db, workspaceId, actorId, reply, log } = opts;
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
	let answer: T;
	try {
		answer = await opts.call();
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
	const { action, metadata } = opts.audit(answer);
	await db.transaction().execute(async (trx) => {
		await recordAudit(trx, {
			actor: `user:${actorId}`,
			target: workspaceId,
			action,
			result: "ok",
			metadata,
		});
		if (opts.after) await opts.after(trx, answer);
	});
	return answer;
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
	const { agent, pid, body, onExited } = opts;
	const signal = body.force ? "SIGKILL" : "SIGTERM";
	return actThroughAgent({
		...opts,
		call: () => agent.stopProcess(pid, body),
		audit: ({ exited }) => ({
			action: "workspace.process_stopped",
			metadata: { pid, signal, exited },
		}),
		after: async (trx, { exited }) => {
			if (exited && onExited) await onExited(trx);
		},
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
