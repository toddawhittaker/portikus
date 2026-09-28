import type { EgressApplyPolicy } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createEgressSync, EGRESS_RETRY_SECONDS } from "./egress.js";
import { FakeControllerClient } from "./fake-controller.js";

const skip = !hasTestDb();
let tdb: TestDb;

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
	await tdb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.execute();
});

async function setPolicy(values: {
	mode?: string;
	presets?: string[];
	ports?: number[];
	version: number;
	applied?: number | null;
}): Promise<void> {
	await tdb.db
		.updateTable("settings")
		.set({
			egress_mode: values.mode ?? "allow-list",
			egress_presets: values.presets ?? ["github"],
			egress_ports: values.ports ?? [443, 22],
			egress_version: values.version,
			egress_applied_version: values.applied ?? null,
		})
		.where("id", "=", 1)
		.execute();
}

async function settings() {
	return tdb.db
		.selectFrom("settings")
		.select(["egress_applied_version", "egress_applied_at", "egress_apply_error"])
		.where("id", "=", 1)
		.executeTakeFirstOrThrow();
}

async function audits() {
	return tdb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "action", "result", "metadata"])
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("the egress apply loop (ADR 0038)", () => {
	test("applies an expanded policy when the version is ahead, and records it", async () => {
		await setPolicy({ version: 3, applied: 2 });
		await tdb.db
			.insertInto("egress_entries")
			.values([
				{ kind: "host", value: "api.example.edu", label: "Course" },
				{ kind: "range", value: "203.0.113.0/24", label: "Lab" },
			])
			.execute();
		const controller = new FakeControllerClient();
		const now = new Date("2026-09-27T12:00:00Z");
		await createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
			now: () => now,
		})();

		const sent = controller.calls.find((c) => c.method === "applyEgressPolicy")
			?.args[0] as EgressApplyPolicy;
		expect(sent).toEqual({
			version: 3,
			mode: "allow-list",
			names: ["api.example.edu", "ghcr.io", "github.com", "githubusercontent.com"],
			ranges: ["203.0.113.0/24"],
			ports: [22, 443],
			blocked: [],
		});
		const s = await settings();
		expect(s.egress_applied_version).toBe(3);
		expect(s.egress_applied_at?.toISOString()).toBe(now.toISOString());
		expect(s.egress_apply_error).toBeNull();
		const rows = await audits();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actor: "worker",
			target: "egress",
			action: "egress.applied",
			result: "ok",
		});
		// Counts only: no names in the audit row.
		expect(rows[0]?.metadata).toEqual({
			version: 3,
			mode: "allow-list",
			names: 4,
			ranges: 1,
			ports: [22, 443],
			blocked: 0,
		});
	});

	test("open mode sends the blocked sites, and the audit row holds only their count (ADR 0043)", async () => {
		await setPolicy({ mode: "open", version: 2, applied: 1 });
		await tdb.db
			.insertInto("egress_blocked_entries")
			.values([
				{ value: "games.com", label: "Games" },
				{ value: "dns.google", label: "" },
			])
			.execute();
		const controller = new FakeControllerClient();
		await createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
		})();
		const sent = controller.calls.find((c) => c.method === "applyEgressPolicy")
			?.args[0] as EgressApplyPolicy;
		expect(sent.mode).toBe("open");
		expect(sent.blocked).toEqual(["dns.google", "games.com"]);
		const rows = await audits();
		expect(rows[0]?.metadata).toMatchObject({ mode: "open", blocked: 2 });
		expect(JSON.stringify(rows[0]?.metadata)).not.toContain("games.com");
	});

	test("does nothing when applied is current, or before any administrator write", async () => {
		const controller = new FakeControllerClient();
		const tick = createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
		});
		await setPolicy({ version: 0 });
		await tick();
		await setPolicy({ version: 4, applied: 4 });
		await tick();
		expect(controller.calls).toEqual([]);
	});

	test("a failure is recorded, audited once, and retried after the rest", async () => {
		await setPolicy({ version: 5, applied: 4 });
		const controller = new FakeControllerClient();
		controller.egressResult = FakeControllerClient.error(
			"TIMEOUT",
			"the egress helper did not answer",
		);
		let t = new Date("2026-09-27T12:00:00Z").getTime();
		const tick = createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
			now: () => new Date(t),
		});
		await tick();
		expect((await settings()).egress_apply_error).toBe(
			"the egress helper did not answer",
		);
		expect((await settings()).egress_applied_version).toBe(4);

		// Within the rest: not retried.
		t += 1000;
		await tick();
		expect(controller.calls).toHaveLength(1);

		// After the rest: retried, and still one audit row for this version.
		t += EGRESS_RETRY_SECONDS * 1000;
		await tick();
		expect(controller.calls).toHaveLength(2);
		const failed = (await audits()).filter((a) => a.action === "egress.apply_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			result: "failed",
			metadata: expect.objectContaining({ errorCode: "TIMEOUT", version: 5 }),
		});

		// Then it works: error cleared, applied recorded.
		controller.egressResult = { appliedVersion: 5, appliedAt: null, error: null };
		t += EGRESS_RETRY_SECONDS * 1000;
		await tick();
		const s = await settings();
		expect(s.egress_applied_version).toBe(5);
		expect(s.egress_apply_error).toBeNull();
	});

	test("a newer version is applied at once, even while an older one rests", async () => {
		await setPolicy({ version: 5, applied: 4 });
		const controller = new FakeControllerClient();
		controller.egressResult = FakeControllerClient.error("OPERATION_FAILED");
		const tick = createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
		});
		await tick();
		controller.egressResult = { appliedVersion: 6, appliedAt: null, error: null };
		await setPolicy({ version: 6, applied: 4 });
		await tick();
		expect(controller.calls).toHaveLength(2);
		expect((await settings()).egress_applied_version).toBe(6);
	});

	test("never moves the applied version backwards", async () => {
		await setPolicy({ version: 5, applied: 4 });
		const controller = new FakeControllerClient();
		// Someone else recorded version 9 while this call was out.
		controller.applyEgressPolicy = async () => {
			await tdb.db.updateTable("settings").set({ egress_applied_version: 9 }).execute();
			return { appliedVersion: 5, appliedAt: null, error: null };
		};
		await createEgressSync({
			db: tdb.db,
			controller,
			logger: collectingLogger().logger,
		})();
		expect((await settings()).egress_applied_version).toBe(9);
	});
});
