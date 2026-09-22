import { HealthSample } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import {
	createHealthSampler,
	HEALTH_SAMPLE_SECONDS,
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

/** Wait on real time for the database to catch up with a fake-clock tick. */
async function until(check: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("condition not met");
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

test.skipIf(skip)(
	"one sample is written now and then one every 60 seconds",
	async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
		const controller = new FakeControllerClient();
		const { logger } = collectingLogger();
		const stop = startHealthSampling({ db: tdb.db, controller, logger });
		try {
			await until(async () => (await samples()).length === 1);

			vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 1000 - 1);
			await new Promise((r) => setTimeout(r, 50));
			expect(await samples()).toHaveLength(1);

			for (let n = 2; n <= 4; n++) {
				vi.advanceTimersByTime(n === 2 ? 1 : HEALTH_SAMPLE_SECONDS * 1000);
				await until(async () => (await samples()).length === n);
			}
			const times = (await samples()).map((r) => r.observed_at.toISOString());
			expect(times).toEqual([
				"2026-09-22T12:00:00.000Z",
				"2026-09-22T12:01:00.000Z",
				"2026-09-22T12:02:00.000Z",
				"2026-09-22T12:03:00.000Z",
			]);
		} finally {
			stop();
		}
		vi.advanceTimersByTime(HEALTH_SAMPLE_SECONDS * 5000);
		await new Promise((r) => setTimeout(r, 50));
		expect(await samples()).toHaveLength(4);
	},
);
