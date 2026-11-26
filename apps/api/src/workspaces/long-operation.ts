import { randomUUID } from "node:crypto";
import {
	ApiError as ApiErrorBody,
	type Project,
	type ProjectOperation,
	type ProjectOperationKind,
} from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { sendError } from "../http.js";

/**
 * Workspaces with a long project operation (clone, template, duplicate,
 * download) running right now. Clone and copy hold a request open for
 * minutes, and two at once on one workspace race over the same directories.
 * This is per API process; the pilot runs exactly one (ADR 0010).
 */
const longOperations = new Set<string>();

/**
 * Claim the one long-operation slot for a workspace. Returns false after
 * answering 409, so the caller just returns.
 */
export function claimLongOperation(workspaceId: string, reply: FastifyReply): boolean {
	if (!holdLongOperation(workspaceId)) {
		sendError(
			reply,
			409,
			"OPERATION_IN_PROGRESS",
			"Another project operation is already running on this workspace.",
		);
		return false;
	}
	return true;
}

/** Claim the long-operation slot without answering; false when it is already held. */
export function holdLongOperation(workspaceId: string): boolean {
	if (longOperations.has(workspaceId)) return false;
	longOperations.add(workspaceId);
	return true;
}

/** Give the long-operation slot back. */
export function releaseLongOperation(workspaceId: string): void {
	longOperations.delete(workspaceId);
}

/** How long a finished operation stays readable, so a reload still finds it. */
export const FINISHED_OPERATION_KEEP_MS = 5 * 60_000;

interface OperationRecord {
	operation: ProjectOperation;
	/** Two requests with the same key are the same request sent twice. */
	key: string;
}

/** Each workspace's current or most recent operation; per process (ADR 0010). */
const operations = new Map<string, OperationRecord>();

/**
 * Collects what a route would have answered, so the slow half of a request
 * can keep its existing `sendError` calls and their texts unchanged.
 */
class OperationReply {
	statusCode = 200;
	body: unknown = undefined;
	status(code: number): this {
		this.statusCode = code;
		return this;
	}
	code(code: number): this {
		return this.status(code);
	}
	header(): this {
		return this;
	}
	send(body?: unknown): this {
		this.body = body;
		return this;
	}
	/** Typed as the Fastify reply the shared helpers take; they only use the methods above. */
	asReply(): FastifyReply {
		return this as unknown as FastifyReply;
	}
}

/** The workspace's current or most recent operation, or null. */
export function currentOperation(workspaceId: string): ProjectOperation | null {
	return operations.get(workspaceId)?.operation ?? null;
}

/** The running operation that `key` names, so a repeated request joins it. */
export function runningOperation(
	workspaceId: string,
	key: string,
): ProjectOperation | null {
	const record = operations.get(workspaceId);
	if (record?.operation.state !== "running" || record.key !== key) return null;
	return record.operation;
}

/**
 * Run `work` in the background. The caller already holds the workspace's
 * long-operation slot; it is released when the work ends. `work` answers on
 * the reply it is given as the route used to: a 4xx or 5xx answer is the
 * operation's failure, anything else its success with the project returned.
 */
export function startOperation(
	input: {
		workspaceId: string;
		key: string;
		kind: ProjectOperationKind;
		projectId: string | null;
		pointId: string | null;
		log: FastifyBaseLogger;
	},
	work: (reply: FastifyReply) => Promise<Project | null>,
): ProjectOperation {
	const operation: ProjectOperation = {
		id: randomUUID(),
		kind: input.kind,
		state: "running",
		projectId: input.projectId,
		pointId: input.pointId,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		project: null,
		error: null,
	};
	const record: OperationRecord = { operation, key: input.key };
	operations.set(input.workspaceId, record);
	const reply = new OperationReply();
	void work(reply.asReply())
		.then((project) => {
			const failed = ApiErrorBody.safeParse(reply.body);
			if (reply.statusCode >= 400) {
				finish(record, {
					state: "failed",
					error: failed.success
						? { status: reply.statusCode, ...failed.data }
						: { status: reply.statusCode, ...UNEXPECTED },
				});
			} else {
				finish(record, { state: "succeeded", project });
			}
		})
		.catch((error: unknown) => {
			input.log.error(
				{ workspaceId: input.workspaceId, kind: input.kind, err: error },
				"project operation failed unexpectedly",
			);
			finish(record, { state: "failed", error: { status: 500, ...UNEXPECTED } });
		})
		.finally(() => {
			releaseLongOperation(input.workspaceId);
			setTimeout(() => {
				if (operations.get(input.workspaceId) === record) {
					operations.delete(input.workspaceId);
				}
			}, FINISHED_OPERATION_KEEP_MS).unref();
		});
	return operation;
}

const UNEXPECTED = {
	code: "INTERNAL",
	message: "Something went wrong. Please try again.",
} as const;

function finish(record: OperationRecord, change: Partial<ProjectOperation>): void {
	record.operation = {
		...record.operation,
		...change,
		finishedAt: new Date().toISOString(),
	};
}
