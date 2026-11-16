import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiMembership,
	insertTestUser,
	type TestDb,
} from "../testing.js";
import { down as stepDown } from "./0062_assistant_conversations.js";

/** A conversation is one person's, kept as an event log, with approvals claimed once (SPEC.md sections 20.4, 24.1). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0062 tests.");
}

describe.skipIf(!hasTestDb())("migration 0062_assistant_conversations", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	async function conversation(userId: string, courseId?: string): Promise<string> {
		const row = await t.db
			.insertInto("assistant_conversations")
			.values({ user_id: userId, ...(courseId ? { course_id: courseId } : {}) })
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	function approval(conversationId: string, toolCallId: string, extra = {}) {
		return t.db
			.insertInto("assistant_approvals")
			.values({
				conversation_id: conversationId,
				tool_call_id: toolCallId,
				operation: "users.disable",
				input: JSON.stringify({ id: "x" }),
				risk: "change",
				...extra,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
	}

	test("a new conversation has no course or context, is writable, and has used no tokens", async () => {
		const id = await conversation(await insertTestUser(t.db));
		const row = await t.db
			.selectFrom("assistant_conversations")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(row.course_id).toBeNull();
		expect(row.context).toBeNull();
		expect(row.read_only).toBe(false);
		expect(row.title).toBeNull();
		expect(row.tokens_used).toBe("0");
		expect(row.last_active_at).toBeInstanceOf(Date);
		await expect(
			sql`update assistant_conversations set tokens_used = -1`.execute(t.db),
		).rejects.toThrow(/check/);
	});

	test("deleting a person or a course removes their conversations, events and approvals", async () => {
		const owner = await insertTestUser(t.db);
		const other = await insertTestUser(t.db);
		const course = await insertTestLtiMembership(t.db, other, { contextId: "c-0062" });
		const ownerChat = await conversation(owner);
		const courseChat = await conversation(other, course);
		const keptChat = await conversation(other);
		for (const id of [ownerChat, courseChat, keptChat]) {
			await t.db
				.insertInto("assistant_events")
				.values({ conversation_id: id, seq: 1, event: JSON.stringify({ type: "x" }) })
				.execute();
			await approval(id, "call-1");
		}
		await t.db.deleteFrom("users").where("id", "=", owner).execute();
		await t.db.deleteFrom("lti_contexts").where("id", "=", course).execute();
		const left = await t.db
			.selectFrom("assistant_conversations")
			.select("id")
			.execute();
		expect(left.map((r) => r.id)).toEqual([keptChat]);
		expect(
			await t.db.selectFrom("assistant_events").select("seq").execute(),
		).toHaveLength(1);
		expect(
			await t.db.selectFrom("assistant_approvals").select("id").execute(),
		).toHaveLength(1);
	});

	test("an event's sequence number is unique within its conversation only", async () => {
		const user = await insertTestUser(t.db);
		const a = await conversation(user);
		const b = await conversation(user);
		const event = (id: string, seq: number) =>
			t.db
				.insertInto("assistant_events")
				.values({ conversation_id: id, seq, event: JSON.stringify({ n: seq }) })
				.execute();
		await event(a, 1);
		await event(b, 1);
		await expect(event(a, 1)).rejects.toThrow(/duplicate|unique/);
		await expect(
			sql`insert into assistant_events (conversation_id, seq) values (${a}, 2)`.execute(
				t.db,
			),
		).rejects.toThrow(/null/);
	});

	test("an approval starts pending, its risk and status are checked, and a tool call has one", async () => {
		const id = await conversation(await insertTestUser(t.db));
		const row = await approval(id, "call-1");
		expect(row.status).toBe("pending");
		expect(row.decided_at).toBeNull();
		expect(row.confirm_text).toBeNull();
		await approval(id, "call-2", {
			risk: "destructive",
			confirm_text: "users.disable",
		});
		await expect(approval(id, "call-1")).rejects.toThrow(/duplicate|unique/);
		await expect(approval(id, "call-3", { risk: "read" })).rejects.toThrow(/check/);
		await expect(approval(id, "call-4", { status: "maybe" })).rejects.toThrow(/check/);
		for (const status of ["approved", "denied", "expired"]) {
			await approval(id, `done-${status}`, { status });
		}
	});

	test("only the first of two claims on a pending approval wins", async () => {
		const id = await conversation(await insertTestUser(t.db));
		const row = await approval(id, "call-1");
		const claim = () =>
			t.db
				.updateTable("assistant_approvals")
				.set({ status: "approved", decided_at: new Date().toISOString() })
				.where("id", "=", row.id)
				.where("status", "=", "pending")
				.executeTakeFirst();
		const results = await Promise.all([claim(), claim()]);
		expect(results.map((r) => Number(r.numUpdatedRows)).sort()).toEqual([0, 1]);
	});

	test("the owner and age indexes exist, and the pending index covers only pending rows", async () => {
		const { rows } = await sql<{ indexname: string; indexdef: string }>`
			select indexname, indexdef from pg_indexes
			where tablename in ('assistant_conversations', 'assistant_approvals')`.execute(
			t.db,
		);
		const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
		expect(defs.assistant_conversations_owner_idx).toMatch(
			/\(user_id, last_active_at DESC\)/,
		);
		expect(defs.assistant_conversations_active_idx).toMatch(/\(last_active_at\)/);
		expect(defs.assistant_approvals_pending_idx).toMatch(/WHERE \(status = 'pending'/);
	});

	test("down drops all three tables", async () => {
		await stepDown(t.db as unknown as Kysely<unknown>);
		for (const table of [
			"assistant_conversations",
			"assistant_events",
			"assistant_approvals",
		]) {
			await expect(sql.raw(`select 1 from ${table}`).execute(t.db)).rejects.toThrow(
				/does not exist/,
			);
		}
	});
});
