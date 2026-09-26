import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { Logger } from "@portikus/observability";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	API_LATENCY_BOUNDS_MS,
	latencyBucket,
	registerRequestMetrics,
} from "./request-metrics.js";

/** Per-minute API totals (docs/EPIC-19.md rulings 21 to 24, issue #599). */

describe("latencyBucket", () => {
	test("puts a time in the first bucket whose bound it does not exceed", () => {
		expect(latencyBucket(0)).toBe(0);
		expect(latencyBucket(5)).toBe(0);
		expect(latencyBucket(5.1)).toBe(1);
		expect(latencyBucket(10_000)).toBe(API_LATENCY_BOUNDS_MS.length - 1);
		expect(latencyBucket(10_001)).toBe(API_LATENCY_BOUNDS_MS.length);
	});
});

function fakeLogger() {
	const warn = vi.fn();
	return { logger: { warn } as unknown as Logger, warn };
}

function testApp(
	db: Kysely<Database>,
	logger: Logger,
	clock: { at: Date },
	flushIntervalMs?: number,
) {
	const app = Fastify();
	registerRequestMetrics(app, {
		db,
		logger,
		now: () => clock.at,
		...(flushIntervalMs === undefined ? {} : { flushIntervalMs }),
	});
	app.get("/health", async () => "ok");
	app.get("/ok", async () => "ok");
	app.get("/missing", async (_request, reply) => reply.status(404).send("no"));
	app.get("/broken", async (_request, reply) => reply.status(500).send("no"));
	app.get("/socket", async () => "ok");
	return app;
}

describe("registerRequestMetrics", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		if (hasTestDb()) await t.truncate();
	});

	async function rows() {
		return t.db
			.selectFrom("api_request_samples")
			.selectAll()
			.orderBy("minute")
			.execute();
	}

	test.skipIf(!hasTestDb())(
		"counts 2xx, 4xx and 5xx, keeps upgrades apart, skips /health, and writes on close",
		async () => {
			const clock = { at: new Date("2026-09-26T10:00:10Z") };
			const { logger } = fakeLogger();
			const app = testApp(t.db, logger, clock);
			await app.inject("/ok");
			await app.inject("/ok");
			await app.inject("/missing");
			await app.inject("/broken");
			await app.inject("/health");
			await app.inject({ url: "/socket", headers: { upgrade: "websocket" } });
			await app.close();

			const [row, ...rest] = await rows();
			expect(rest).toEqual([]);
			expect(row?.minute.toISOString()).toBe("2026-09-26T10:00:00.000Z");
			expect(row?.requests).toBe(4);
			expect(row?.client_errors).toBe(1);
			expect(row?.server_errors).toBe(1);
			expect(row?.websocket_upgrades).toBe(1);
			expect(row?.latency_buckets).toHaveLength(API_LATENCY_BOUNDS_MS.length + 1);
			expect(row?.latency_buckets.reduce((a, b) => a + b, 0)).toBe(4);
		},
	);

	test.skipIf(!hasTestDb())("a new minute starts a new row", async () => {
		const clock = { at: new Date("2026-09-26T10:00:59Z") };
		const { logger } = fakeLogger();
		const app = testApp(t.db, logger, clock);
		await app.inject("/ok");
		clock.at = new Date("2026-09-26T10:01:00Z");
		await app.inject("/ok");
		await app.inject("/ok");
		await app.close();

		expect(
			(await rows()).map((row) => [row.minute.toISOString(), row.requests]),
		).toEqual([
			["2026-09-26T10:00:00.000Z", 1],
			["2026-09-26T10:01:00.000Z", 2],
		]);
	});

	test.skipIf(!hasTestDb())(
		"adds to a minute a previous process already wrote",
		async () => {
			const clock = { at: new Date("2026-09-26T10:00:10Z") };
			const { logger } = fakeLogger();
			const first = testApp(t.db, logger, clock);
			await first.inject("/ok");
			await first.close();
			const second = testApp(t.db, logger, clock);
			await second.inject("/ok");
			await second.inject("/missing");
			await second.close();

			const [row, ...rest] = await rows();
			expect(rest).toEqual([]);
			expect(row?.requests).toBe(3);
			expect(row?.client_errors).toBe(1);
			expect(row?.latency_buckets.reduce((a, b) => a + b, 0)).toBe(3);
		},
	);

	test.skipIf(!hasTestDb())(
		"the timer writes finished minutes and prunes rows older than 7 days at most hourly",
		async () => {
			const clock = { at: new Date("2026-09-26T10:00:10Z") };
			const { logger } = fakeLogger();
			const old = {
				requests: 1,
				client_errors: 0,
				server_errors: 0,
				websocket_upgrades: 0,
				latency_buckets: [1],
			};
			await t.db
				.insertInto("api_request_samples")
				.values({ ...old, minute: new Date("2026-09-19T09:00:00Z") })
				.execute();
			const app = testApp(t.db, logger, clock, 10);
			await app.ready();
			await app.inject("/ok");
			clock.at = new Date("2026-09-26T10:01:00Z");
			await vi.waitFor(async () => {
				expect((await rows()).map((row) => row.minute.toISOString())).toEqual([
					"2026-09-26T10:00:00.000Z",
				]);
			});

			// Another stale row inside the hour survives until an hour has passed.
			await t.db
				.insertInto("api_request_samples")
				.values({ ...old, minute: new Date("2026-09-19T09:30:00Z") })
				.execute();
			clock.at = new Date("2026-09-26T10:30:00Z");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await rows()).toHaveLength(2);
			clock.at = new Date("2026-09-26T11:02:00Z");
			await vi.waitFor(async () => {
				expect(await rows()).toHaveLength(1);
			});
			await app.close();
		},
	);

	test("a failed write is logged at warn with the message only and dropped", async () => {
		const down = () => {
			throw new Error("database down");
		};
		const db = { getExecutor: down, deleteFrom: down } as unknown as Kysely<Database>;
		const clock = { at: new Date("2026-09-26T10:00:10Z") };
		const { logger, warn } = fakeLogger();
		const app = testApp(db, logger, clock);
		await app.inject("/ok");
		await app.close();

		expect(warn).toHaveBeenCalledWith(
			{ error: "database down" },
			"api request metrics write failed",
		);
	});
});
