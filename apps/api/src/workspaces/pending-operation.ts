import type { PendingOperation } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { sendError } from "../http.js";
import { holdLongOperation, releaseLongOperation } from "./long-operation.js";

/**
 * "busy" means a restore or copy holds the project folders; "pending" means
 * another maintenance operation already waits on the workspace.
 */
export type PendingOperationResult = "ok" | "busy" | "pending";

/**
 * Record a maintenance operation for the worker to drive, and audit it in the
 * same transaction (SPEC.md §16.4, §17.2; ADR 0021). The long-operation slot
 * is held while the row is written, so a restore cannot start in between, and
 * the `is null` guard makes two racing requests safe.
 */
export async function requestPendingOperation(
	db: Kysely<Database>,
	input: {
		workspaceId: string;
		userId: string;
		operation: PendingOperation;
		/** Stored in `pending_operation_args` when given. */
		args?: Record<string, unknown>;
		action: string;
		metadata: Record<string, unknown>;
	},
): Promise<PendingOperationResult> {
	const { workspaceId, userId } = input;
	if (!holdLongOperation(workspaceId)) return "busy";
	try {
		const now = new Date().toISOString();
		return await db.transaction().execute(async (trx) => {
			const result = await trx
				.updateTable("workspaces")
				.set({
					pending_operation: input.operation,
					...(input.args === undefined
						? {}
						: { pending_operation_args: JSON.stringify(input.args) }),
					pending_operation_at: now,
					pending_operation_by: userId,
					updated_at: now,
				})
				.where("id", "=", workspaceId)
				.where("pending_operation", "is", null)
				.executeTakeFirst();
			if (result.numUpdatedRows === 0n) return "pending";
			await recordAudit(trx, {
				actor: `user:${userId}`,
				target: workspaceId,
				action: input.action,
				result: "ok",
				metadata: input.metadata,
			});
			return "ok";
		});
	} finally {
		releaseLongOperation(workspaceId);
	}
}

/** Answer 409 for a request that was not recorded. */
export function sendPendingOperationRefusal(
	reply: FastifyReply,
	result: Exclude<PendingOperationResult, "ok">,
): FastifyReply {
	if (result === "busy") {
		return sendError(
			reply,
			409,
			"OPERATION_IN_PROGRESS",
			"A project operation such as a restore is running on this workspace. Try again when it finishes.",
		);
	}
	return sendError(
		reply,
		409,
		"OPERATION_PENDING",
		"Another maintenance operation is already waiting on this workspace.",
	);
}
