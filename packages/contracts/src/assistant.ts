import { z } from "zod";
import {
	ChatEventSchemas,
	Envelope,
	MAX_CHAT_TEXT_CHARS,
	PermissionAnswerMessage,
} from "./chat.js";

/**
 * The admin assistant speaks the student chat's wire events, so the web
 * chat store reads them unchanged. `sessionId` holds the conversation id:
 * both are uuids. Reconnect uses the chat's own `snapshot` event.
 */
export const AssistantServerEvent = z.discriminatedUnion("type", [
	ChatEventSchemas.SnapshotEvent,
	ChatEventSchemas.TurnStartedEvent,
	ChatEventSchemas.TextDeltaEvent,
	ChatEventSchemas.MessageEvent,
	ChatEventSchemas.ToolStartedEvent,
	ChatEventSchemas.ToolOutputEvent,
	ChatEventSchemas.ToolFinishedEvent,
	ChatEventSchemas.PermissionRequestedEvent,
	ChatEventSchemas.CardResolvedEvent,
	ChatEventSchemas.TurnFinishedEvent,
	/** A plain refusal or failure, such as a message sent while a turn runs; the chat's own `error`. */
	z.object({ type: z.literal("error"), ...Envelope, message: z.string() }),
]);
export type AssistantServerEvent = z.infer<typeof AssistantServerEvent>;

/**
 * A subset of the chat's client messages, so the chat store's own
 * `send`, `answerPermission` and `interrupt` produce them. No attachments.
 */
export const AssistantClientMessage = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("send"),
			text: z.string().min(1).max(MAX_CHAT_TEXT_CHARS),
			attachments: z.array(z.never()).max(0),
		})
		.strict(),
	PermissionAnswerMessage,
	z.object({ type: z.literal("interrupt") }).strict(),
]);
export type AssistantClientMessage = z.infer<typeof AssistantClientMessage>;

export const AssistantContextKind = z.enum(["health", "workspace", "job", "alert"]);
export type AssistantContextKind = z.infer<typeof AssistantContextKind>;

/** The item a Diagnose button opens the conversation about. */
export const AssistantContext = z
	.object({
		kind: AssistantContextKind,
		id: z.string().min(1).max(200).optional(),
	})
	.strict();
export type AssistantContext = z.infer<typeof AssistantContext>;

export const CreateConversationRequest = z
	.object({
		courseId: z.string().uuid().optional(),
		context: AssistantContext.optional(),
	})
	.strict();
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const ConversationSummary = z.object({
	id: z.string().uuid(),
	title: z.string(),
	courseId: z.string().uuid().nullable(),
	context: AssistantContext.nullable(),
	/** A Diagnose conversation may only read. */
	readOnly: z.boolean(),
	tokensUsed: z.number().int().nonnegative(),
	createdAt: z.string().datetime(),
	lastActiveAt: z.string().datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationList = z.object({
	conversations: z.array(ConversationSummary),
});
export type ConversationList = z.infer<typeof ConversationList>;

/** Most rows one batch approval may cover. */
export const MAX_ASSISTANT_BATCH_ROWS = 100;

/**
 * The `input` of a batch approval card: one operation, one row of inputs
 * per call. Its `confirmText` is the row count.
 */
export const AssistantBatchInput = z
	.object({
		operation: z.string().min(1).max(200),
		rows: z.array(z.record(z.string(), z.json())).min(1).max(MAX_ASSISTANT_BATCH_ROWS),
	})
	.strict();
export type AssistantBatchInput = z.infer<typeof AssistantBatchInput>;

export function batchConfirmText(batch: AssistantBatchInput): string {
	return String(batch.rows.length);
}

/** Why the assistant cannot be used now, or null when it can (SPEC.md section 20.4). */
export const AssistantUnavailableReason = z.enum([
	"off",
	"no-key",
	"notice",
	"monthly-cap",
]);
export type AssistantUnavailableReason = z.infer<typeof AssistantUnavailableReason>;

/** Whether the assistant can be used. Any staff member may ask. */
export const AssistantStatus = z.object({
	enabled: z.boolean(),
	reason: AssistantUnavailableReason.nullable(),
});
export type AssistantStatus = z.infer<typeof AssistantStatus>;
