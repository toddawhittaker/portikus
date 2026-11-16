import {
	type AssistantBatchInput,
	batchConfirmText,
	type ChatCardDecision,
} from "@portikus/contracts";
import type { Operation } from "../catalog/index.js";
import type { OperationInputValues } from "../catalog/run.js";
import { toolName } from "../mcp/server.js";
import { BATCH_TOOL } from "./batch.js";
import type { StoredEvent } from "./store.js";

/**
 * Approval cards (SPEC.md sections 20.4 and 24.1), drawn by code from the
 * catalog entry and the checked inputs only, never from the model's words.
 * Approve or Deny, nothing that lasts beyond this one call.
 */

const APPROVE = "approve";
const DENY = "deny";

export type ApprovalRisk = "change" | "destructive";

/** What a person must type to approve: the operation's name, for a destructive call only. */
export function confirmTextFor(operation: Operation): string | null {
	return operation.risk === "destructive" ? operation.name : null;
}

export function approvalCard(
	toolCallId: string,
	operation: Operation & { risk: ApprovalRisk },
	input: OperationInputValues,
): Extract<StoredEvent, { type: "permission.requested" }> {
	const confirmText = confirmTextFor(operation);
	return {
		type: "permission.requested",
		id: toolCallId,
		toolName: toolName(operation),
		title: operation.description,
		input: JSON.parse(JSON.stringify(input)),
		options: [
			{ id: APPROVE, label: "Approve", decision: "allowed" },
			{ id: DENY, label: "Deny", decision: "denied" },
		],
		risk: operation.risk,
		...(confirmText === null ? {} : { confirmText }),
	};
}

/**
 * The card for a batch: the operation's description as the title, the rows
 * as its input, and the row count as the confirmation for change and
 * destructive batches alike.
 */
export function batchCard(
	toolCallId: string,
	operation: Operation & { risk: ApprovalRisk },
	batch: AssistantBatchInput,
): Extract<StoredEvent, { type: "permission.requested" }> {
	return {
		...approvalCard(toolCallId, operation, {}),
		toolName: BATCH_TOOL,
		input: JSON.parse(JSON.stringify(batch)),
		confirmText: batchConfirmText(batch),
	};
}

/**
 * The decision an answer makes. A destructive card counts as approved only
 * when the typed confirmation equals its text exactly; anything else denies.
 */
export function decide(
	answer: { optionId: string; confirmation?: string | undefined },
	confirmText: string | null,
): "approved" | "denied" {
	if (answer.optionId !== APPROVE) return "denied";
	if (confirmText !== null && answer.confirmation !== confirmText) return "denied";
	return "approved";
}

export function cardDecision(status: "approved" | "denied"): ChatCardDecision {
	return status === "approved" ? "allowed" : "denied";
}

/** What the model reads when a person denies a call. */
export const REFUSED_TEXT = JSON.stringify({
	code: "DENIED",
	message: "The person denied this call. It did not run.",
});

/** What the model reads when nobody answered a card in time. */
export const EXPIRED_TEXT = JSON.stringify({
	code: "EXPIRED",
	message: "Nobody answered the approval in time. It did not run.",
});
