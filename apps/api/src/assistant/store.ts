import {
	AssistantContext,
	type AssistantServerEvent,
	type ConversationSummary,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, type Selectable, sql } from "kysely";

/**
 * Assistant conversations in PostgreSQL (SPEC.md sections 20.4 and 24.1).
 * Every read and write names the owner, so no caller reaches another
 * person's conversation. Events are the chat wire events, never the model
 * library's own message format.
 */

export type ConversationRow = Selectable<Database["assistant_conversations"]>;
export type ApprovalRow = Selectable<Database["assistant_approvals"]>;

/** A stored event: a wire event without its envelope, which the hub adds on sending. */
export type StoredEvent = DistributiveOmit<AssistantServerEvent, "sessionId" | "seq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** What a new conversation is called until its first message names it. */
const UNTITLED = "New conversation";
const TITLE_CHARS = 80;

/** A conversation's title: the first line of its first message, shortened. */
function titleFrom(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	if (line === "") return UNTITLED;
	return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1)}…`;
}

export function toSummary(row: ConversationRow): ConversationSummary {
	const context = AssistantContext.safeParse(row.context);
	return {
		id: row.id,
		title: row.title ?? UNTITLED,
		courseId: row.course_id,
		context: context.success ? context.data : null,
		readOnly: row.read_only,
		tokensUsed: Number(row.tokens_used),
		createdAt: row.created_at.toISOString(),
		lastActiveAt: row.last_active_at.toISOString(),
	};
}

export async function createConversation(
	db: Kysely<Database>,
	values: {
		userId: string;
		courseId: string | null;
		context: AssistantContext | null;
		readOnly: boolean;
	},
): Promise<ConversationRow> {
	return db
		.insertInto("assistant_conversations")
		.values({
			user_id: values.userId,
			course_id: values.courseId,
			context: values.context === null ? null : JSON.stringify(values.context),
			read_only: values.readOnly,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
}

export function listConversations(
	db: Kysely<Database>,
	userId: string,
): Promise<ConversationRow[]> {
	return db
		.selectFrom("assistant_conversations")
		.selectAll()
		.where("user_id", "=", userId)
		.orderBy("last_active_at", "desc")
		.orderBy("created_at", "desc")
		.execute();
}

/** The conversation when it is this person's; undefined otherwise. */
export function ownConversation(
	db: Kysely<Database>,
	userId: string,
	id: string,
): Promise<ConversationRow | undefined> {
	return db
		.selectFrom("assistant_conversations")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", userId)
		.executeTakeFirst();
}

/** True when a conversation of this person's was deleted; its events and approvals go with it. */
export async function deleteConversation(
	db: Kysely<Database>,
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.deleteFrom("assistant_conversations")
		.where("id", "=", id)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	return Number(result.numDeletedRows) > 0;
}

/** Set the title from the first message, once. */
export async function nameConversation(
	db: Kysely<Database>,
	id: string,
	text: string,
): Promise<void> {
	await db
		.updateTable("assistant_conversations")
		.set({ title: titleFrom(text) })
		.where("id", "=", id)
		.where("title", "is", null)
		.execute();
}

/** Add a step's tokens and mark the conversation used. */
export async function addTokens(
	db: Kysely<Database>,
	id: string,
	tokens: number,
): Promise<void> {
	await db
		.updateTable("assistant_conversations")
		.set({
			tokens_used: sql`tokens_used + ${tokens}`,
			last_active_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
}

export async function touchConversation(
	db: Kysely<Database>,
	id: string,
): Promise<void> {
	await db
		.updateTable("assistant_conversations")
		.set({ last_active_at: new Date().toISOString() })
		.where("id", "=", id)
		.execute();
}

export async function tokensUsed(db: Kysely<Database>, id: string): Promise<number> {
	const row = await db
		.selectFrom("assistant_conversations")
		.select("tokens_used")
		.where("id", "=", id)
		.executeTakeFirst();
	return Number(row?.tokens_used ?? 0);
}

export async function maxSeq(db: Kysely<Database>, id: string): Promise<number> {
	const row = await db
		.selectFrom("assistant_events")
		.select(sql<number | null>`max(seq)`.as("seq"))
		.where("conversation_id", "=", id)
		.executeTakeFirst();
	return Number(row?.seq ?? 0);
}

export async function appendEvent(
	db: Kysely<Database>,
	id: string,
	seq: number,
	event: StoredEvent,
): Promise<void> {
	await db
		.insertInto("assistant_events")
		.values({ conversation_id: id, seq, event: JSON.stringify(event) })
		.execute();
}

/** The stored events in order, each with its seq. */
export async function loadEvents(
	db: Kysely<Database>,
	id: string,
): Promise<{ seq: number; event: StoredEvent }[]> {
	const rows = await db
		.selectFrom("assistant_events")
		.select(["seq", "event"])
		.where("conversation_id", "=", id)
		.orderBy("seq")
		.execute();
	return rows.map((row) => ({ seq: row.seq, event: row.event as StoredEvent }));
}

export async function insertApproval(
	db: Kysely<Database>,
	values: {
		conversationId: string;
		toolCallId: string;
		operation: string;
		input: unknown;
		risk: "change" | "destructive";
		confirmText: string | null;
	},
): Promise<void> {
	await db
		.insertInto("assistant_approvals")
		.values({
			conversation_id: values.conversationId,
			tool_call_id: values.toolCallId,
			operation: values.operation,
			input: JSON.stringify(values.input),
			risk: values.risk,
			confirm_text: values.confirmText,
		})
		.execute();
}

export function pendingApproval(
	db: Kysely<Database>,
	conversationId: string,
	toolCallId: string,
): Promise<ApprovalRow | undefined> {
	return db
		.selectFrom("assistant_approvals")
		.selectAll()
		.where("conversation_id", "=", conversationId)
		.where("tool_call_id", "=", toolCallId)
		.where("status", "=", "pending")
		.executeTakeFirst();
}

/**
 * Decide a pending approval. Only the first claim gets the row back, so a
 * second tab or a replayed answer cannot run the call twice.
 */
export function claimApproval(
	db: Kysely<Database>,
	conversationId: string,
	toolCallId: string,
	status: "approved" | "denied",
): Promise<ApprovalRow | undefined> {
	return db
		.updateTable("assistant_approvals")
		.set({ status, decided_at: new Date().toISOString() })
		.where("conversation_id", "=", conversationId)
		.where("tool_call_id", "=", toolCallId)
		.where("status", "=", "pending")
		.returningAll()
		.executeTakeFirst();
}

export async function countPending(
	db: Kysely<Database>,
	conversationId: string,
): Promise<number> {
	const row = await db
		.selectFrom("assistant_approvals")
		.select(sql<string>`count(*)`.as("n"))
		.where("conversation_id", "=", conversationId)
		.where("status", "=", "pending")
		.executeTakeFirstOrThrow();
	return Number(row.n);
}
