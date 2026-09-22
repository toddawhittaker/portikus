import { randomUUID } from "node:crypto";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	createPreviewDeniedAudit,
	PREVIEW_DENIED_WINDOW_MS,
} from "./audit-throttle.js";

const skip = !hasTestDb();
let testDb: TestDb;

/** The only keys a preview.denied row may carry (STACK.md §15, ADR 0012). */
const ALLOWED_METADATA_KEYS = ["count", "reason", "workspaceId"];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
});

async function deniedRows() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "preview.denied")
		.orderBy("id")
		.execute();
}

test.skipIf(skip)("ten refusals in a minute give one row with count 10", async () => {
	let now = 1_000_000;
	const audit = createPreviewDeniedAudit(testDb.db, () => now);
	const workspaceId = randomUUID();
	const userId = randomUUID();
	// Half of them at once, as a page's burst of subresources would arrive.
	await Promise.all(
		Array.from({ length: 5 }, () =>
			audit.record({ workspaceId, userId, reason: "port_mismatch" }),
		),
	);
	for (let i = 0; i < 5; i++) {
		now += 5_000;
		await audit.record({ workspaceId, userId, reason: "port_mismatch" });
	}

	const rows = await deniedRows();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.metadata).toEqual({
		reason: "port_mismatch",
		workspaceId,
		count: 10,
	});
	expect(rows[0]?.actor).toBe(`user:${userId}`);
	expect(rows[0]?.target).toBe(workspaceId);
	expect(Object.keys(rows[0]?.metadata ?? {}).sort()).toEqual(ALLOWED_METADATA_KEYS);
});

test.skipIf(skip)("a new minute, reason or workspace starts a new row", async () => {
	let now = 1_000_000;
	const audit = createPreviewDeniedAudit(testDb.db, () => now);
	const first = randomUUID();
	const second = randomUUID();
	const userId = randomUUID();

	await audit.record({ workspaceId: first, userId, reason: "host_mismatch" });
	await audit.record({ workspaceId: first, userId, reason: "not_owner" });
	await audit.record({ workspaceId: second, userId, reason: "host_mismatch" });
	now += PREVIEW_DENIED_WINDOW_MS;
	await audit.record({ workspaceId: first, userId, reason: "host_mismatch" });

	const rows = await deniedRows();
	expect(
		rows.map((row) => [row.target, row.metadata?.reason, row.metadata?.count]),
	).toEqual([
		[first, "host_mismatch", 1],
		[first, "not_owner", 1],
		[second, "host_mismatch", 1],
		[first, "host_mismatch", 1],
	]);
});
