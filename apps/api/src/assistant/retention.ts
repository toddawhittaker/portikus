import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { EXPIRED_TEXT } from "./cards.js";
import type { AssistantHub } from "./hub.js";

/**
 * Keeping conversations no longer than they are needed (SPEC.md section
 * 20.4): a conversation goes 30 days after its last use, and a card nobody
 * answered in a day expires. At startup, a turn the last process was
 * running when it stopped is closed as interrupted.
 */

const CONVERSATION_DAYS = 30;
const APPROVAL_HOURS = 24;
const TICK_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Delete old conversations and expire old cards; returns how many of each. */
export async function sweepAssistant(
	db: Kysely<Database>,
	hub: AssistantHub,
	now: Date = new Date(),
): Promise<{ deleted: number; expired: number }> {
	const deleted = await db
		.deleteFrom("assistant_conversations")
		.where("last_active_at", "<", new Date(now.getTime() - CONVERSATION_DAYS * DAY_MS))
		.executeTakeFirst();
	const expired = await db
		.updateTable("assistant_approvals")
		.set({ status: "expired", decided_at: now.toISOString() })
		.where("status", "=", "pending")
		.where("created_at", "<", new Date(now.getTime() - APPROVAL_HOURS * 60 * 60_000))
		.returning(["conversation_id", "tool_call_id"])
		.execute();
	for (const row of expired) {
		const id = row.conversation_id;
		await hub.emit(id, { type: "card.resolved", id: row.tool_call_id });
		await hub.emit(id, {
			type: "tool.output",
			id: row.tool_call_id,
			part: { type: "text", text: EXPIRED_TEXT },
		});
		await hub.emit(id, { type: "tool.finished", id: row.tool_call_id, isError: true });
	}
	return { deleted: Number(deleted.numDeletedRows), expired: expired.length };
}

/** Close every turn a stopped process left running; returns how many. */
export async function closeLeftOpenTurns(
	db: Kysely<Database>,
	hub: AssistantHub,
): Promise<number> {
	const rows = await db
		.selectFrom("assistant_events")
		.select("conversation_id")
		.groupBy("conversation_id")
		.having(
			sql<boolean>`max(seq) filter (where event->>'type' = 'turn.started')
				> coalesce(max(seq) filter (where event->>'type' = 'turn.finished'), 0)`,
		)
		.execute();
	for (const row of rows) {
		if (hub.isRunning(row.conversation_id)) continue;
		await hub.emit(row.conversation_id, {
			type: "turn.finished",
			status: "interrupted",
			at: Date.now(),
		});
	}
	return rows.length;
}

/**
 * Close left-open turns, then sweep now and every hour; errors are logged,
 * never thrown. The returned stop waits for work already started.
 */
export function startAssistantRetention(options: {
	db: Kysely<Database>;
	hub: AssistantHub;
	logger: Logger;
}): () => Promise<void> {
	const { db, hub, logger } = options;
	const failed = (what: string) => (error: unknown) => {
		logger.error({ error: error instanceof Error ? error.name : "unknown" }, what);
	};
	const sweep = async (): Promise<void> => {
		const { deleted, expired } = await sweepAssistant(db, hub);
		if (deleted > 0 || expired > 0)
			logger.info({ deleted, expired }, "assistant retention sweep");
	};
	let work: Promise<void> = closeLeftOpenTurns(db, hub)
		.then((closed) => {
			if (closed > 0) logger.info({ closed }, "assistant turns closed at startup");
		})
		.catch(failed("could not close assistant turns at startup"))
		.then(sweep)
		.catch(failed("assistant retention sweep failed"));
	const timer = setInterval(() => {
		work = work.then(sweep).catch(failed("assistant retention sweep failed"));
	}, TICK_MS);
	timer.unref();
	return async () => {
		clearInterval(timer);
		await work;
	};
}
