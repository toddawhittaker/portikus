import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { holdLongOperation, releaseLongOperation } from "./long-operation.js";
import { requestPendingOperation } from "./pending-operation.js";

const skip = !hasTestDb();
let tdb: TestDb;
let userId: string;
let workspaceId: string;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
	userId = await insertTestUser(tdb.db);
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: "pending-op",
			owner_user_id: userId,
			state: "running",
			desired_state: "running",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	workspaceId = row.id;
});

function rebuild(args?: Record<string, unknown>) {
	return requestPendingOperation(tdb.db, {
		workspaceId,
		userId,
		operation: "rebuild",
		args,
		action: "workspace.rebuild_requested",
		metadata: { resetDocker: false },
	});
}

async function audits() {
	return tdb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "action", "result", "metadata"])
		.where("target", "=", workspaceId)
		.execute();
}

test.skipIf(skip)(
	"records the operation and its audit row (SPEC.md §17.2)",
	async () => {
		expect(await rebuild({ restoreRequestId: "r1" })).toBe("ok");
		const row = await tdb.db
			.selectFrom("workspaces")
			.select(["pending_operation", "pending_operation_args", "pending_operation_by"])
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			pending_operation: "rebuild",
			pending_operation_args: { restoreRequestId: "r1" },
			pending_operation_by: userId,
		});
		expect(await audits()).toEqual([
			{
				actor: `user:${userId}`,
				target: workspaceId,
				action: "workspace.rebuild_requested",
				result: "ok",
				metadata: { resetDocker: false },
			},
		]);
		// The slot is given back once the row is written.
		expect(holdLongOperation(workspaceId)).toBe(true);
		releaseLongOperation(workspaceId);
	},
);

test.skipIf(skip)(
	"a second request while one waits is pending and not audited",
	async () => {
		expect(await rebuild()).toBe("ok");
		expect(await rebuild()).toBe("pending");
		expect(await audits()).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"a running restore or copy makes it busy and writes nothing",
	async () => {
		holdLongOperation(workspaceId);
		try {
			expect(await rebuild()).toBe("busy");
		} finally {
			releaseLongOperation(workspaceId);
		}
		const row = await tdb.db
			.selectFrom("workspaces")
			.select("pending_operation")
			.where("id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(row.pending_operation).toBeNull();
		expect(await audits()).toEqual([]);
	},
);
