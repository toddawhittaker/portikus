import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import Fastify from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	CounterUnavailable,
	createStoredCounter,
	PRUNE_EVERY_MS,
	pruneEndedCounters,
	registerCounterPrune,
} from "./stored-counter.js";

/**
 * Sign-in guess counts kept in PostgreSQL (SPEC.md section 24.13, ADR 0053):
 * exact under parallel hits, kept across a restart, given back only by the
 * request that was counted, and refused when the store fails.
 */

const WINDOW = 10 * 60_000;

/** A database whose every connection fails, as when PostgreSQL is down. */
function brokenDb(): Kysely<Database> {
	const pool = {
		connect: async () => {
			throw new Error("connection refused");
		},
		end: async () => {},
	};
	return new Kysely<Database>({
		dialect: new PostgresDialect({ pool: pool as never }),
	});
}

describe("a counter store that fails", () => {
	test("refuses: a hit rejects with CounterUnavailable, never lets the try through", async () => {
		const { logger } = collectingLogger("debug");
		const counter = createStoredCounter({
			db: brokenDb(),
			logger,
			scope: "password",
			limit: 10,
			windowMs: WINDOW,
		});
		await expect(counter.attempt("198.51.100.1")).rejects.toBeInstanceOf(
			CounterUnavailable,
		);
		await expect(counter.add("198.51.100.1")).rejects.toBeInstanceOf(
			CounterUnavailable,
		);
	});

	test("a give-back that fails is logged and keeps the count", async () => {
		const { logger, lines } = collectingLogger("debug");
		const counter = createStoredCounter({
			db: brokenDb(),
			logger,
			scope: "password",
			limit: 10,
			windowMs: WINDOW,
		});
		await counter.giveBack({
			scope: "password",
			key: "198.51.100.1",
			windowStart: new Date(),
			spent: false,
		});
		expect(lines.some((l) => l.msg === "could not give a sign-in count back")).toBe(
			true,
		);
	});
});

describe("the hourly prune", () => {
	test("runs while the server is up and stops when it closes", async () => {
		let calls = 0;
		const db = {
			deleteFrom: () => ({
				where: () => ({
					executeTakeFirst: async () => {
						calls += 1;
						return { numDeletedRows: 0n };
					},
				}),
			}),
		} as unknown as Kysely<Database>;
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const app = Fastify();
			registerCounterPrune(app, { db, logger: collectingLogger("debug").logger });
			await app.ready();
			vi.advanceTimersByTime(PRUNE_EVERY_MS);
			expect(calls).toBe(1);
			await app.close();
			vi.advanceTimersByTime(3 * PRUNE_EVERY_MS);
			expect(calls).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

const skip = !hasTestDb();

describe.skipIf(skip)("the stored counter", () => {
	let t: TestDb;
	let clock: number;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t.close();
	});

	beforeEach(async () => {
		await t.truncate();
		clock = Date.parse("2026-10-06T12:00:00Z");
	});

	function counter(limit = 10, scope = "password") {
		return createStoredCounter({
			db: t.db,
			logger: collectingLogger("debug").logger,
			scope,
			limit,
			windowMs: WINDOW,
			now: () => clock,
		});
	}

	async function stored(scope: string, key: string) {
		return t.db
			.selectFrom("signin_counters")
			.select(["count", "reported"])
			.where("scope", "=", scope)
			.where("key", "=", key)
			.executeTakeFirst();
	}

	test("parallel hits count exactly, and only the limit gets through", async () => {
		const c = counter(10);
		const decisions = await Promise.all(
			Array.from({ length: 25 }, () => c.attempt("198.51.100.1")),
		);
		expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
		expect((await stored("password", "198.51.100.1"))?.count).toBe(25);
	});

	test("parallel refusals ask for exactly one audit row", async () => {
		const c = counter(2);
		await c.attempt("k");
		await c.attempt("k");
		const refusals = await Promise.all(
			Array.from({ length: 20 }, () => c.attempt("k")),
		);
		expect(refusals.every((d) => !d.allowed && d.receipt === null)).toBe(true);
		expect(refusals.filter((d) => d.audit)).toHaveLength(1);
		expect((await stored("password", "k"))?.reported).toBe(true);
	});

	test("a restart keeps the count: a new store on the same database still refuses", async () => {
		const before = counter(3);
		for (let i = 0; i < 3; i++) expect((await before.attempt("k")).allowed).toBe(true);
		const after = counter(3);
		const refused = await after.attempt("k");
		expect(refused.allowed).toBe(false);
		expect(refused.audit).toBe(true);
	});

	test("a new window starts the count and the first refusal again", async () => {
		const c = counter(1);
		await c.attempt("k");
		expect((await c.attempt("k")).audit).toBe(true);
		clock += WINDOW - 1;
		expect((await c.attempt("k")).allowed).toBe(false);
		clock += 1;
		expect((await c.attempt("k")).allowed).toBe(true);
		expect(await c.attempt("k")).toEqual({
			allowed: false,
			audit: true,
			receipt: null,
		});
	});

	test("scopes and keys are counted apart", async () => {
		const passwords = counter(1, "password");
		const accounts = counter(1, "password-account");
		await passwords.attempt("k");
		expect((await passwords.attempt("k")).allowed).toBe(false);
		expect((await passwords.attempt("other")).allowed).toBe(true);
		expect((await accounts.attempt("k")).allowed).toBe(true);
	});

	test("a receipt gives back one count, once", async () => {
		const c = counter(2);
		const first = await c.attempt("k");
		if (!first.receipt) throw new Error("expected a receipt");
		await c.giveBack(first.receipt);
		await c.giveBack(first.receipt);
		expect((await stored("password", "k"))?.count).toBe(0);
		await c.attempt("k");
		await c.attempt("k");
		// Spent: it cannot open a third try.
		await c.giveBack(first.receipt);
		expect((await c.attempt("k")).allowed).toBe(false);
	});

	test("a receipt from an ended window gives nothing back in the new one", async () => {
		const c = counter(1);
		const old = await c.attempt("k");
		if (!old.receipt) throw new Error("expected a receipt");
		clock += WINDOW;
		expect((await c.attempt("k")).allowed).toBe(true);
		await c.giveBack(old.receipt);
		expect((await stored("password", "k"))?.count).toBe(1);
		expect((await c.attempt("k")).allowed).toBe(false);
	});

	test("a receipt for another scope gives nothing back here", async () => {
		const passwords = counter(1, "password");
		const accounts = counter(1, "password-account");
		const mine = await accounts.attempt("k");
		await passwords.attempt("k");
		if (!mine.receipt) throw new Error("expected a receipt");
		await passwords.giveBack(mine.receipt);
		expect((await stored("password", "k"))?.count).toBe(1);
	});

	test("add counts without asking, and is refused like any other hit after", async () => {
		const c = counter(2);
		await c.add("k");
		await c.add("k");
		expect((await c.attempt("k")).allowed).toBe(false);
	});

	test("the prune deletes only counts whose window has ended", async () => {
		const now = new Date(clock);
		const row = (key: string, endsInMinutes: number) => ({
			scope: "password",
			key,
			window_started_at: new Date(clock + (endsInMinutes - 10) * 60_000),
			expires_at: new Date(clock + endsInMinutes * 60_000),
			count: 3,
		});
		await t.db
			.insertInto("signin_counters")
			.values([row("ended", -1), row("ends-now", 0), row("live", 1)])
			.execute();
		expect(await pruneEndedCounters(t.db, now)).toBe(2);
		const left = await t.db.selectFrom("signin_counters").select("key").execute();
		expect(left.map((r) => r.key)).toEqual(["live"]);
	});

	test("a row expires when its window ends", async () => {
		const c = counter(5);
		await c.attempt("k");
		const row = await t.db
			.selectFrom("signin_counters")
			.select(["window_started_at", "expires_at"])
			.executeTakeFirstOrThrow();
		expect(row.window_started_at.getTime()).toBe(clock);
		expect(row.expires_at.getTime()).toBe(clock + WINDOW);
	});
});
