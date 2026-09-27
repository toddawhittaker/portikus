import { HealthSample } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import {
	createHealthSampler,
	HEALTH_SAMPLE_SECONDS,
	nextPoolLevel,
	startHealthSampling,
} from "./health.js";

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
	await tdb.db.deleteFrom("health_samples").execute();
});

afterEach(() => {
	vi.useRealTimers();
});

async function samples() {
	return tdb.db
		.selectFrom("health_samples")
		.select(["observed_at", "sample"])
		.orderBy("id")
		.execute();
}

test.skipIf(skip)(
	"a reachable controller gives a sample with the host snapshot",
	async () => {
		const controller = new FakeControllerClient();
		const { logger } = collectingLogger();
		const at = new Date("2026-09-22T12:00:00Z");
		await createHealthSampler({ db: tdb.db, controller, logger, now: () => at })();

		const rows = await samples();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.observed_at.toISOString()).toBe(at.toISOString());
		const sample = HealthSample.parse(rows[0]?.sample);
		expect(sample.controller).toEqual({ reachable: true, errorCode: null });
		expect(sample.host?.image.serial).toBe("2026.09.9");
	},
);

test.skipIf(skip)("the host snapshot is asked with a 20 second timeout", async () => {
	const controller = new FakeControllerClient();
	const timeout = vi.spyOn(AbortSignal, "timeout");
	const { logger } = collectingLogger();
	await createHealthSampler({ db: tdb.db, controller, logger })();
	expect(timeout).toHaveBeenCalledWith(20_000);
	const call = controller.calls.find((c) => c.method === "hostSnapshot");
	expect(call?.args[0]).toBeInstanceOf(AbortSignal);
	timeout.mockRestore();
});

test.skipIf(skip)("only the newest sample keeps the instance list", async () => {
	const controller = new FakeControllerClient();
	const host = controller.hostResult as Exclude<typeof controller.hostResult, Error>;
	controller.hostResult = {
		...host,
		instances: [{ name: "ws-a", imageFingerprint: "abc123", imageSerial: "2026.09.9" }],
	};
	const { logger } = collectingLogger();
	const tick = createHealthSampler({ db: tdb.db, controller, logger });
	await tick();
	await tick();
	await tick();

	const lists = (await samples()).map(
		(r) => HealthSample.parse(r.sample).host?.instances.length,
	);
	expect(lists).toEqual([0, 0, 1]);
});

test.skipIf(skip)(
	"an unreachable controller still writes a row with the error code",
	async () => {
		const controller = new FakeControllerClient();
		controller.hostResult = new ControllerClientError("INCUS_UNAVAILABLE", "down");
		const { logger } = collectingLogger();
		await createHealthSampler({ db: tdb.db, controller, logger })();

		const rows = await samples();
		expect(rows).toHaveLength(1);
		expect(HealthSample.parse(rows[0]?.sample)).toEqual({
			controller: { reachable: false, errorCode: "INCUS_UNAVAILABLE" },
			host: null,
		});
	},
);

test.skipIf(skip)("an unexpected failure is recorded as OPERATION_FAILED", async () => {
	const controller = new FakeControllerClient();
	controller.hostResult = new Error("schema mismatch");
	const { logger } = collectingLogger();
	await createHealthSampler({ db: tdb.db, controller, logger })();
	const sample = HealthSample.parse((await samples())[0]?.sample);
	expect(sample.controller.errorCode).toBe("OPERATION_FAILED");
});

test.skipIf(skip)("rows older than 7 days are pruned, newer ones kept", async () => {
	const now = new Date("2026-09-22T12:00:00Z");
	const day = 86_400_000;
	for (const age of [8 * day, 7 * day + 60_000, 6 * day]) {
		await tdb.db
			.insertInto("health_samples")
			.values({
				observed_at: new Date(now.getTime() - age).toISOString(),
				sample: JSON.stringify({
					controller: { reachable: true, errorCode: null },
					host: null,
				}),
			})
			.execute();
	}
	const { logger } = collectingLogger();
	await createHealthSampler({
		db: tdb.db,
		controller: new FakeControllerClient(),
		logger,
		now: () => now,
	})();

	const kept = (await samples()).map((r) => now.getTime() - r.observed_at.getTime());
	expect(kept).toEqual([6 * day, 0]);
});

test.skipIf(skip)("a database failure is logged and does not throw", async () => {
	const { logger, lines } = collectingLogger();
	const broken = {
		insertInto: () => {
			throw new Error("db down");
		},
	} as unknown as TestDb["db"];
	await createHealthSampler({
		db: broken,
		controller: new FakeControllerClient(),
		logger,
	})();
	expect(lines.some((l) => l.msg === "health sample failed")).toBe(true);
});

test("the sampler runs once at start, then once every 60 seconds until stopped", () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let calls = 0;
	const tick = async () => {
		calls++;
	};
	const { logger } = collectingLogger();
	const stop = startHealthSampling(
		{ db: {} as TestDb["db"], controller: new FakeControllerClient(), logger },
		tick,
	);
	expect(calls).toBe(1);
	vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 1000 - 1);
	expect(calls).toBe(1);
	vi.advanceTimersByTime(1);
	expect(calls).toBe(2);
	vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 1000);
	expect(calls).toBe(3);
	vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 1000);
	expect(calls).toBe(4);
	stop();
	vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 5000);
	expect(calls).toBe(4);
});

test.skipIf(skip)(
	"each sample is stamped with the clock time of its tick",
	async () => {
		const start = new Date("2026-09-22T12:00:00Z").getTime();
		let at = start;
		const { logger } = collectingLogger();
		const tick = createHealthSampler({
			db: tdb.db,
			controller: new FakeControllerClient(),
			logger,
			now: () => new Date(at),
		});
		for (let n = 0; n < 4; n++) {
			at = start + n * HEALTH_SAMPLE_SECONDS * 1000;
			await tick();
		}
		const times = (await samples()).map((r) => r.observed_at.toISOString());
		expect(times).toEqual([
			"2026-09-22T12:00:00.000Z",
			"2026-09-22T12:01:00.000Z",
			"2026-09-22T12:02:00.000Z",
			"2026-09-22T12:03:00.000Z",
		]);
	},
);

test("the pool level rises at 70 and 90 and re-arms 5 points below", () => {
	expect(nextPoolLevel(0, 69.9)).toBe(0);
	expect(nextPoolLevel(0, 70)).toBe(70);
	expect(nextPoolLevel(0, 95)).toBe(90);
	expect(nextPoolLevel(70, 66)).toBe(70);
	expect(nextPoolLevel(70, 64.9)).toBe(0);
	expect(nextPoolLevel(90, 86)).toBe(90);
	expect(nextPoolLevel(90, 84)).toBe(70);
	expect(nextPoolLevel(90, 50)).toBe(0);
});

test.skipIf(skip)(
	"administrators are told when the pool crosses 70 and 90 percent, once per crossing",
	async () => {
		const users = await tdb.db
			.insertInto("users")
			.values(
				[
					["admin", "administrator", null],
					["gone", "administrator", new Date().toISOString()],
					["student", "student", null],
				].map(([name, role, disabledAt]) => ({
					oidc_issuer: "https://issuer.test",
					oidc_subject: name as string,
					display_name: name as string,
					role: role as string,
					disabled_at: disabledAt,
				})),
			)
			.returning(["id", "oidc_subject"])
			.execute();
		const adminId = users.find((u) => u.oidc_subject === "admin")?.id;

		const controller = new FakeControllerClient();
		const host = controller.hostResult as Exclude<typeof controller.hostResult, Error>;
		const setFill = (data: number, metadata: number | null) => {
			controller.hostResult = {
				...host,
				pool: {
					...host.pool,
					usedBytes: data,
					totalBytes: 100,
					metadataPercent: metadata,
				},
			};
		};
		const { logger } = collectingLogger();
		const tick = createHealthSampler({ db: tdb.db, controller, logger });

		for (const [data, metadata] of [
			[50, null],
			[40, 71.4], // metadata alone crosses 70
			[72, 10], // still over 70: no repeat
			[91, 10], // crosses 90
			[80, 10], // falls, but not 5 points below 70
			[60, 10], // re-arms
			[70, 10], // crosses 70 again
		] as const) {
			setFill(data, metadata);
			await tick();
		}

		const rows = await tdb.db
			.selectFrom("notifications")
			.select(["user_id", "tone", "title"])
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		expect(rows.every((row) => row.user_id === adminId)).toBe(true);
		expect(rows.map((row) => [row.tone, row.title])).toEqual([
			["warning", "Storage pool is 71% full"],
			["danger", "Storage pool is 91% full; new workspaces are refused"],
			["warning", "Storage pool is 70% full"],
		]);
	},
);
