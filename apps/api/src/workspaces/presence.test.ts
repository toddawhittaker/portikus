import { PassThrough } from "node:stream";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { holdPresenceWhile } from "./presence.js";

/**
 * A streaming download counts as presence for as long as it streams, so the
 * idle stop does not cut it off when no page is open (SPEC.md §6.4, §11.2).
 */

const skip = !hasTestDb();
let testDb: TestDb;

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

async function makeWorkspace(): Promise<string> {
	const row = await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: await insertTestUser(testDb.db),
			state: "running",
			label: `ws-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function connections(workspaceId: string): Promise<number> {
	const rows = await testDb.db
		.selectFrom("workspace_connections")
		.select("id")
		.where("workspace_id", "=", workspaceId)
		.execute();
	return rows.length;
}

async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test.skipIf(skip)("a stream holds presence until it ends", async () => {
	const workspaceId = await makeWorkspace();
	const stream = new PassThrough();
	await holdPresenceWhile(testDb.db, workspaceId, stream);
	expect(await connections(workspaceId)).toBe(1);
	stream.end("zip bytes");
	stream.resume();
	await until(async () => (await connections(workspaceId)) === 0);
});

test.skipIf(skip)("an aborted stream gives presence back", async () => {
	const workspaceId = await makeWorkspace();
	const stream = new PassThrough();
	await holdPresenceWhile(testDb.db, workspaceId, stream);
	expect(await connections(workspaceId)).toBe(1);
	stream.destroy(new Error("browser went away"));
	await until(async () => (await connections(workspaceId)) === 0);
});

test.skipIf(skip)("a stream that ends while presence opens leaves no row", async () => {
	const workspaceId = await makeWorkspace();
	const stream = new PassThrough();
	const held = holdPresenceWhile(testDb.db, workspaceId, stream);
	stream.destroy();
	await held;
	await until(async () => (await connections(workspaceId)) === 0);
});
