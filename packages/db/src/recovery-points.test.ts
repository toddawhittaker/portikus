import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	countProjectPoints,
	MAX_POINTS_PER_PROJECT,
	recordRecoveryPoint,
} from "./recovery-points.js";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "./testing.js";

const SHA = "a".repeat(64);
const FP = "b".repeat(64);

describe.skipIf(!hasTestDb())("recordRecoveryPoint", () => {
	let t: TestDb;
	let workspaceId: string;
	let projectId: string;
	let n = 0;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		n++;
		const ws = await t.db
			.insertInto("workspaces")
			.values({
				label: `rp-${n}`,
				owner_user_id: await insertTestUser(t.db),
				incus_instance_name: `ws-rp-${n}`,
				state: "running",
				desired_state: "running",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		workspaceId = ws.id;
		const p = await t.db
			.insertInto("projects")
			.values({
				workspace_id: workspaceId,
				slug: `p${n}`,
				name: `p${n}`,
				path: `/home/student/projects/p${n}`,
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		projectId = p.id;
	});

	const base = () => ({
		projectId,
		workspaceId,
		reason: "manual" as const,
		createdBy: "user:x",
		retentionDays: 7,
	});

	test("calls the agent first, then writes the row under the id it was given", async () => {
		const order: string[] = [];
		let given = "";
		const before = Date.now();
		const row = await recordRecoveryPoint(t.db, {
			...base(),
			archive: async (pointId) => {
				given = pointId;
				order.push(`agent:${await countProjectPoints(t.db, projectId)}`);
				return { created: true, sizeBytes: 4096, sha256: SHA, fingerprint: FP };
			},
		});
		order.push(`after:${await countProjectPoints(t.db, projectId)}`);
		expect(order).toEqual(["agent:0", "after:1"]);
		expect(row?.id).toBe(given);
		expect(row).toMatchObject({
			project_id: projectId,
			workspace_id: workspaceId,
			reason: "manual",
			created_by: "user:x",
			sha256: SHA,
			fingerprint: FP,
		});
		expect(Number(row?.size_bytes)).toBe(4096);
		const created = row?.created_at.getTime() ?? 0;
		expect(created).toBeGreaterThanOrEqual(before - 1000);
		expect((row?.expires_at.getTime() ?? 0) - created).toBe(7 * 86_400_000);
	});

	test("writes nothing and returns null when the agent skips", async () => {
		const row = await recordRecoveryPoint(t.db, {
			...base(),
			archive: async () => ({ created: false, fingerprint: FP }),
		});
		expect(row).toBeNull();
		expect(await countProjectPoints(t.db, projectId)).toBe(0);
	});

	test("passes the agent's failure through and writes no row", async () => {
		const failure = Object.assign(new Error("down"), { code: "AGENT_UNAVAILABLE" });
		await expect(
			recordRecoveryPoint(t.db, {
				...base(),
				archive: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(await countProjectPoints(t.db, projectId)).toBe(0);
	});

	test("counts points per project against the cap", async () => {
		expect(MAX_POINTS_PER_PROJECT).toBe(200);
		for (let i = 0; i < 2; i++) {
			await recordRecoveryPoint(t.db, {
				...base(),
				archive: async () => ({
					created: true,
					sizeBytes: 1,
					sha256: SHA,
					fingerprint: FP,
				}),
			});
		}
		expect(await countProjectPoints(t.db, projectId)).toBe(2);
	});
});
