import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { silentLogger } from "@portikus/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAssistantHub } from "./hub.js";
import {
	closeLeftOpenTurns,
	startAssistantRetention,
	sweepAssistant,
} from "./retention.js";
import {
	appendEvent,
	createConversation,
	insertApproval,
	loadEvents,
} from "./store.js";

/** Conversations go 30 days after last use, and unanswered cards expire in a day (SPEC.md section 20.4). */

const skip = !hasTestDb();
let t: TestDb;

beforeAll(async () => {
	if (skip) return;
	t = await createTestDb();
});
afterAll(async () => {
	await t?.close();
});
beforeEach(async () => {
	if (skip) return;
	await t.truncate();
});

const DAY = 24 * 60 * 60_000;

async function conversation(userId: string, lastActive: Date): Promise<string> {
	const row = await createConversation(t.db, {
		userId,
		courseId: null,
		context: null,
		readOnly: false,
	});
	await t.db
		.updateTable("assistant_conversations")
		.set({ last_active_at: lastActive.toISOString() })
		.where("id", "=", row.id)
		.execute();
	return row.id;
}

describe.skipIf(skip)("assistant retention", () => {
	test("deletes only conversations last used more than 30 days ago", async () => {
		const user = await insertTestUser(t.db);
		const now = new Date("2026-11-15T12:00:00Z");
		const old = await conversation(user, new Date(now.getTime() - 30 * DAY - 60_000));
		const edge = await conversation(user, new Date(now.getTime() - 30 * DAY + 60_000));
		const fresh = await conversation(user, now);
		await appendEvent(t.db, old, 1, { type: "turn.started", at: 1 });
		const result = await sweepAssistant(t.db, createAssistantHub(t.db), now);
		expect(result).toEqual({ deleted: 1, expired: 0 });
		const left = await t.db
			.selectFrom("assistant_conversations")
			.select("id")
			.execute();
		expect(left.map((r) => r.id).sort()).toEqual([edge, fresh].sort());
		expect(await loadEvents(t.db, old)).toEqual([]);
	});

	test("expires cards pending for more than a day and tells the conversation", async () => {
		const user = await insertTestUser(t.db);
		const id = await conversation(user, new Date());
		for (const call of ["old", "new"]) {
			await insertApproval(t.db, {
				conversationId: id,
				toolCallId: call,
				operation: "users.disable",
				input: {},
				risk: "destructive",
				confirmText: "users.disable",
			});
		}
		await t.db
			.updateTable("assistant_approvals")
			.set({ created_at: new Date(Date.now() - DAY - 60_000) } as never)
			.where("tool_call_id", "=", "old")
			.execute();
		const result = await sweepAssistant(t.db, createAssistantHub(t.db));
		expect(result).toEqual({ deleted: 0, expired: 1 });
		const rows = await t.db
			.selectFrom("assistant_approvals")
			.select(["tool_call_id", "status"])
			.orderBy("tool_call_id")
			.execute();
		expect(rows).toEqual([
			{ tool_call_id: "new", status: "pending" },
			{ tool_call_id: "old", status: "expired" },
		]);
		expect((await loadEvents(t.db, id)).map((e) => e.event)).toMatchObject([
			{ type: "card.resolved", id: "old" },
			{ type: "tool.output", id: "old" },
			{ type: "tool.finished", id: "old", isError: true },
		]);
	});

	test("at startup a turn left running is closed as interrupted", async () => {
		const user = await insertTestUser(t.db);
		const open = await conversation(user, new Date());
		const closed = await conversation(user, new Date());
		await appendEvent(t.db, open, 1, { type: "turn.started", at: 1 });
		await appendEvent(t.db, closed, 1, { type: "turn.started", at: 1 });
		await appendEvent(t.db, closed, 2, {
			type: "turn.finished",
			status: "done",
			at: 2,
		});
		const hub = createAssistantHub(t.db);
		const stop = startAssistantRetention({ db: t.db, hub, logger: silentLogger() });
		await stop();
		expect((await loadEvents(t.db, open)).at(-1)).toMatchObject({
			seq: 2,
			event: { type: "turn.finished", status: "interrupted" },
		});
		expect(await loadEvents(t.db, closed)).toHaveLength(2);
		expect(await closeLeftOpenTurns(t.db, hub)).toBe(0);
	});
});
