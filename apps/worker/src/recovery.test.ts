import type {
	AgentCreateRecoveryPointRequest,
	AgentCreateRecoveryPointResponse,
} from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { AgentCallError, type RecoveryAgent } from "./agent-client.js";
import { type RecoveryConfig, rebuildPointsDone, recoverySweep } from "./recovery.js";

const skip = !hasTestDb();
let tdb: TestDb;

const cfg: RecoveryConfig = {
	WORKSPACE_RECOVERY_SIZE_GIB: 1,
	RECOVERY_INTERVAL_SECONDS: 900,
	RECOVERY_RETENTION_DAYS: 14,
};

const GIB = 1024 ** 3;
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const SHA = "c".repeat(64);

/** In-memory agent: records calls and answers with settable results. */
class FakeAgent implements RecoveryAgent {
	creates: { slug: string; req: AgentCreateRecoveryPointRequest }[] = [];
	deletes: { projectId: string; pointId: string }[] = [];
	fingerprint = FP_A;
	sizeBytes = 1000;
	createError: Error | null = null;
	deleteError: Error | null = null;

	async createRecoveryPoint(
		slug: string,
		req: AgentCreateRecoveryPointRequest,
	): Promise<AgentCreateRecoveryPointResponse> {
		this.creates.push({ slug, req });
		if (this.createError) throw this.createError;
		if (req.skipIfFingerprint === this.fingerprint) {
			return { created: false, fingerprint: this.fingerprint };
		}
		return {
			created: true,
			sizeBytes: this.sizeBytes,
			sha256: SHA,
			fingerprint: this.fingerprint,
		};
	}

	async deleteRecoveryPoint(projectId: string, pointId: string): Promise<void> {
		this.deletes.push({ projectId, pointId });
		if (this.deleteError) throw this.deleteError;
	}
}

let agent: FakeAgent;
const agentFor = () => agent;

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
	agent = new FakeAgent();
});

let counter = 0;

async function insertWorkspace(
	overrides: Record<string, unknown> = {},
): Promise<string> {
	counter++;
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `rec-${counter}`,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: `ws-rec-${counter}`,
			state: "running",
			desired_state: "running",
			agent_address: "10.0.0.9",
			agent_token: "t".repeat(64),
			quota_config: JSON.stringify({ homeGiB: 25, dockerGiB: 20, recoveryGiB: 1 }),
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function insertProject(
	workspaceId: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	counter++;
	const slug = `p${counter}`;
	const row = await tdb.db
		.insertInto("projects")
		.values({
			workspace_id: workspaceId,
			slug,
			name: slug,
			path: `/home/student/projects/${slug}`,
			source: "new",
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function insertPoint(
	workspaceId: string,
	projectId: string,
	createdAt: Date,
	sizeBytes: number,
	expiresAt: Date,
	fingerprint = FP_B,
): Promise<string> {
	const row = await tdb.db
		.insertInto("recovery_points")
		.values({
			id: crypto.randomUUID(),
			project_id: projectId,
			workspace_id: workspaceId,
			reason: "periodic",
			created_at: createdAt.toISOString(),
			created_by: "worker",
			size_bytes: sizeBytes,
			sha256: SHA,
			fingerprint,
			expires_at: expiresAt.toISOString(),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function points(projectId: string) {
	return tdb.db
		.selectFrom("recovery_points")
		.selectAll()
		.where("project_id", "=", projectId)
		.orderBy("created_at")
		.execute();
}

async function checkedAt(projectId: string): Promise<Date | null> {
	const row = await tdb.db
		.selectFrom("projects")
		.select("recovery_checked_at")
		.where("id", "=", projectId)
		.executeTakeFirstOrThrow();
	return row.recovery_checked_at;
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);
const daysFrom = (now: Date, d: number) => new Date(now.getTime() + d * 86_400_000);

// --- Periodic points (SPEC.md §15.6) ---

test.skipIf(skip)("a due project gets a periodic point with a full row", async () => {
	const ws = await insertWorkspace();
	const pid = await insertProject(ws);
	const now = new Date();

	const result = await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(result.created).toBe(1);
	expect(agent.creates).toHaveLength(1);
	expect(agent.creates[0]?.req.projectId).toBe(pid);
	// No earlier point, so nothing to compare against.
	expect(agent.creates[0]?.req.skipIfFingerprint).toBeUndefined();
	const [row] = await points(pid);
	expect(row).toMatchObject({
		id: agent.creates[0]?.req.pointId,
		workspace_id: ws,
		reason: "periodic",
		created_by: "worker",
		sha256: SHA,
		fingerprint: FP_A,
	});
	expect(Number(row?.size_bytes)).toBe(1000);
	// Stamped when the point is made, not when the sweep began.
	expect(row?.created_at.getTime()).toBeGreaterThanOrEqual(now.getTime());
	expect(row?.expires_at.getTime()).toBe(
		daysFrom(row?.created_at as Date, 14).getTime(),
	);
	expect((await checkedAt(pid))?.getTime()).toBe(now.getTime());
});

test.skipIf(skip)(
	"a point made late in a slow sweep is stamped when it is made",
	async () => {
		const ws = await insertWorkspace();
		const pid = await insertProject(ws);
		const sweepStart = new Date(Date.now() - 60 * 60_000);

		await recoverySweep(tdb.db, agentFor, cfg, sweepStart);

		const [row] = await points(pid);
		expect(row?.created_at.getTime()).toBeGreaterThan(
			sweepStart.getTime() + 30 * 60_000,
		);
	},
);

test.skipIf(skip)(
	"one workspace with a hanging agent does not hold up the others",
	async () => {
		const stuck = await insertWorkspace({ agent_address: "10.0.0.66" });
		await insertProject(stuck);
		const others: string[] = [];
		for (let i = 0; i < 5; i++) {
			const ws = await insertWorkspace();
			others.push(await insertProject(ws));
		}
		let release: () => void = () => {};
		const hanging: RecoveryAgent = {
			createRecoveryPoint: () =>
				new Promise((_resolve, reject) => {
					release = () => reject(new AgentCallError("AGENT_UNAVAILABLE", "timed out"));
				}),
			deleteRecoveryPoint: async () => {},
		};

		const sweep = recoverySweep(
			tdb.db,
			(address) => (address === "10.0.0.66" ? hanging : agent),
			cfg,
			new Date(),
		);
		await expect
			.poll(async () => {
				const counts = await Promise.all(
					others.map(async (p) => (await points(p)).length),
				);
				return counts.every((n) => n === 1);
			})
			.toBe(true);
		release();

		expect(await sweep).toEqual({ created: 5, deleted: 0 });
	},
);

test.skipIf(skip)("point sizes count as whole 4 KiB disk blocks", async () => {
	const now = new Date();
	const ws = await insertWorkspace();
	const a = await insertProject(ws, { recovery_checked_at: now.toISOString() });
	const far = daysFrom(now, 10);
	// Ten points whose bytes sum to just under 75% of 1 GiB, but whose
	// blocks sum to just over it, so exactly the oldest one goes.
	const size = 80_530_636;
	const ids = [];
	for (let i = 10; i >= 1; i--) {
		ids.push(await insertPoint(ws, a, minutesAgo(now, i), size, far));
	}

	const result = await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(result.deleted).toBe(1);
	expect((await points(a)).map((p) => p.id)).toEqual(ids.slice(1));
});

test.skipIf(skip)("a project checked within the interval is not due", async () => {
	const ws = await insertWorkspace();
	const now = new Date();
	await insertProject(ws, { recovery_checked_at: minutesAgo(now, 10).toISOString() });

	await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(agent.creates).toHaveLength(0);
});

test.skipIf(skip)(
	"an unchanged project writes no row but is marked checked",
	async () => {
		const ws = await insertWorkspace();
		const now = new Date();
		const pid = await insertProject(ws, {
			recovery_checked_at: minutesAgo(now, 20).toISOString(),
		});
		await insertPoint(ws, pid, minutesAgo(now, 20), 1000, daysFrom(now, 10), FP_A);

		const result = await recoverySweep(tdb.db, agentFor, cfg, now);

		expect(agent.creates[0]?.req.skipIfFingerprint).toBe(FP_A);
		expect(result.created).toBe(0);
		expect(await points(pid)).toHaveLength(1);
		expect((await checkedAt(pid))?.getTime()).toBe(now.getTime());
	},
);

test.skipIf(skip)("a changed project gets a new point", async () => {
	const ws = await insertWorkspace();
	const now = new Date();
	const pid = await insertProject(ws, {
		recovery_checked_at: minutesAgo(now, 20).toISOString(),
	});
	await insertPoint(ws, pid, minutesAgo(now, 20), 1000, daysFrom(now, 10), FP_B);

	await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(agent.creates[0]?.req.skipIfFingerprint).toBe(FP_B);
	expect(await points(pid)).toHaveLength(2);
});

test.skipIf(skip)(
	"stopped workspaces and archived projects are left alone",
	async () => {
		const stopped = await insertWorkspace({ state: "stopped" });
		await insertProject(stopped);
		const running = await insertWorkspace();
		await insertProject(running, { state: "archived" });

		await recoverySweep(tdb.db, agentFor, cfg, new Date());

		expect(agent.creates).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"an agent failure writes no row and still marks the project",
	async () => {
		const ws = await insertWorkspace();
		const pid = await insertProject(ws);
		agent.createError = new AgentCallError("STORAGE_FULL", "full");
		const now = new Date();

		const result = await recoverySweep(tdb.db, agentFor, cfg, now);

		expect(result.created).toBe(0);
		expect(await points(pid)).toHaveLength(0);
		expect((await checkedAt(pid))?.getTime()).toBe(now.getTime());
	},
);

// --- Before-rebuild points (SPEC.md §22.3) ---

test.skipIf(skip)(
	"a pending rebuild gets a point of every active project, due or not",
	async () => {
		const now = new Date();
		const pendingAt = minutesAgo(now, 1);
		const ws = await insertWorkspace({
			pending_operation: "rebuild",
			pending_operation_at: pendingAt.toISOString(),
		});
		const pid = await insertProject(ws, {
			recovery_checked_at: minutesAgo(now, 5).toISOString(),
		});
		await insertPoint(ws, pid, minutesAgo(now, 5), 1000, daysFrom(now, 10), FP_A);
		expect(await rebuildPointsDone(tdb.db, ws, pendingAt)).toBe(false);

		await recoverySweep(tdb.db, agentFor, cfg, now);

		// Unchanged or not, the rebuild point is always written.
		expect(agent.creates[0]?.req.skipIfFingerprint).toBeUndefined();
		const rows = await points(pid);
		expect(rows.map((r) => r.reason)).toEqual(["periodic", "before-rebuild"]);
		expect(await rebuildPointsDone(tdb.db, ws, pendingAt)).toBe(true);
	},
);

test.skipIf(skip)("a pending reset docker makes no points", async () => {
	const ws = await insertWorkspace({
		pending_operation: "reset-docker",
		pending_operation_at: new Date().toISOString(),
	});
	await insertProject(ws);

	await recoverySweep(tdb.db, agentFor, cfg, new Date());

	expect(agent.creates).toHaveLength(0);
});

// --- Retention (SPEC.md §15.7) ---

test.skipIf(skip)("expired points go, the newest of each project stays", async () => {
	const now = new Date();
	const ws = await insertWorkspace();
	const recent = { recovery_checked_at: now.toISOString() };
	const a = await insertProject(ws, recent);
	const b = await insertProject(ws, recent);
	const aOld = await insertPoint(ws, a, minutesAgo(now, 300), 10, minutesAgo(now, 60));
	const aNew = await insertPoint(ws, a, minutesAgo(now, 200), 10, daysFrom(now, 1));
	// b's only point is expired, but it is b's newest.
	const bOnly = await insertPoint(ws, b, minutesAgo(now, 100), 10, minutesAgo(now, 1));

	const result = await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(result.deleted).toBe(1);
	expect(agent.deletes).toEqual([{ projectId: a, pointId: aOld }]);
	expect((await points(a)).map((p) => p.id)).toEqual([aNew]);
	expect((await points(b)).map((p) => p.id)).toEqual([bOnly]);
});

test.skipIf(skip)(
	"oldest points go until usage is at or below 75% of the allowance",
	async () => {
		const now = new Date();
		const ws = await insertWorkspace();
		const a = await insertProject(ws, { recovery_checked_at: now.toISOString() });
		const far = daysFrom(now, 10);
		const quarter = GIB / 4;
		// Five quarters of 1 GiB: 125%. Removing two leaves 75%, removing one 100%.
		const ids = [];
		for (let i = 5; i >= 1; i--) {
			ids.push(await insertPoint(ws, a, minutesAgo(now, i * 10), quarter, far));
		}

		await recoverySweep(tdb.db, agentFor, cfg, now);

		expect((await points(a)).map((p) => p.id)).toEqual(ids.slice(2));
	},
);

test.skipIf(skip)("the size bound never removes a project's newest point", async () => {
	const now = new Date();
	const ws = await insertWorkspace();
	const recent = { recovery_checked_at: now.toISOString() };
	const a = await insertProject(ws, recent);
	const b = await insertProject(ws, recent);
	const far = daysFrom(now, 10);
	await insertPoint(ws, a, minutesAgo(now, 20), GIB, far);
	await insertPoint(ws, b, minutesAgo(now, 10), GIB, far);

	const result = await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(result.deleted).toBe(0);
	expect(await points(a)).toHaveLength(1);
	expect(await points(b)).toHaveLength(1);
});

test.skipIf(skip)("a failed file delete keeps the row", async () => {
	const now = new Date();
	const ws = await insertWorkspace();
	const a = await insertProject(ws, { recovery_checked_at: now.toISOString() });
	await insertPoint(ws, a, minutesAgo(now, 30), 10, minutesAgo(now, 5));
	await insertPoint(ws, a, minutesAgo(now, 20), 10, daysFrom(now, 1));
	agent.deleteError = new AgentCallError("AGENT_UNAVAILABLE", "down");

	await recoverySweep(tdb.db, agentFor, cfg, now);

	expect(await points(a)).toHaveLength(2);
});
