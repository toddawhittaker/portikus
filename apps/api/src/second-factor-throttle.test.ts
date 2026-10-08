import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createSecondFactorCounts,
	SECOND_FACTOR_DAILY_LIMIT,
} from "./second-factor-throttle.js";

// SPEC.md section 24.13: ten wrong codes per account in ten minutes, and a
// daily cap, across every route that checks a code, kept in PostgreSQL
// (ADR 0053).
const skip = !hasTestDb();

describe.skipIf(skip)("createSecondFactorCounts", () => {
	const MINUTE = 60_000;
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

	function counts() {
		return createSecondFactorCounts({
			db: t.db,
			logger: collectingLogger("debug").logger,
			now: () => clock,
		});
	}

	/** Thirty counted tries, ten in each of three ten-minute windows. */
	async function spendTheDay(c: ReturnType<typeof counts>, userId: string) {
		for (let i = 0; i < SECOND_FACTOR_DAILY_LIMIT; i++) {
			if (i > 0 && i % 10 === 0) clock += 11 * MINUTE;
			expect((await c.attempt(userId)).allowed).toBe(true);
		}
	}

	test("refuses the eleventh try in ten minutes, audited once", async () => {
		const c = counts();
		for (let i = 0; i < 10; i++) expect((await c.attempt("u")).allowed).toBe(true);
		expect(await c.attempt("u")).toEqual({
			allowed: false,
			audit: true,
			daily: false,
			receipt: null,
		});
		expect(await c.attempt("u")).toEqual({
			allowed: false,
			audit: false,
			daily: false,
			receipt: null,
		});
		expect((await c.attempt("v")).allowed).toBe(true);
	});

	test("caps a day at thirty wrong codes, telling the holder once", async () => {
		const c = counts();
		await spendTheDay(c, "u");
		clock += 11 * MINUTE;
		expect(await c.attempt("u")).toEqual({
			allowed: false,
			audit: true,
			daily: true,
			receipt: null,
		});
		clock += 11 * MINUTE;
		expect(await c.attempt("u")).toEqual({
			allowed: false,
			audit: false,
			daily: true,
			receipt: null,
		});
		clock += 24 * 60 * MINUTE;
		expect((await c.attempt("u")).allowed).toBe(true);
	});

	test("a restart keeps the day's count", async () => {
		await spendTheDay(counts(), "u");
		clock += 11 * MINUTE;
		expect((await counts().attempt("u")).daily).toBe(true);
	});

	test("refusals in a short window do not use up the day", async () => {
		const c = counts();
		for (let i = 0; i < 100; i++) await c.attempt("u");
		for (let w = 1; w < 3; w++) {
			clock += 11 * MINUTE;
			for (let i = 0; i < 10; i++) expect((await c.attempt("u")).allowed).toBe(true);
		}
	});

	test("a right code gives its try back to both counts", async () => {
		const c = counts();
		for (let w = 0; w < 5; w++) {
			for (let i = 0; i < 10; i++) {
				const { receipt } = await c.attempt("u");
				expect(receipt).not.toBeNull();
				if (receipt) await c.giveBack(receipt);
			}
			clock += 11 * MINUTE;
		}
	});

	test("a receipt gives back once, and only in its own window", async () => {
		const c = counts();
		const first = (await c.attempt("u")).receipt;
		if (!first) throw new Error("expected a receipt");
		await c.giveBack(first);
		await c.giveBack(first);
		for (let i = 0; i < 9; i++) await c.attempt("u");
		// Ten counted now; a spent receipt must not open an eleventh.
		await c.giveBack(first);
		expect((await c.attempt("u")).allowed).toBe(true);
		expect((await c.attempt("u")).allowed).toBe(false);

		clock += 11 * MINUTE;
		const old = (await c.attempt("v")).receipt;
		clock += 11 * MINUTE;
		for (let i = 0; i < 10; i++) await c.attempt("v");
		if (old) await c.giveBack(old);
		expect((await c.attempt("v")).allowed).toBe(false);
	});

	test("after the daily cap, refused tries hold no receipt to give back", async () => {
		const c = counts();
		await spendTheDay(c, "u");
		clock += 11 * MINUTE;
		// Ten passkey posts with no challenge: each is refused before the lookup.
		for (let i = 0; i < 10; i++) {
			const decision = await c.attempt("u");
			expect(decision.receipt).toBeNull();
			if (decision.receipt) await c.giveBack(decision.receipt);
		}
		expect((await c.attempt("u")).allowed).toBe(false);
	});

	test("parallel tries count exactly: ten of thirty get through", async () => {
		const c = counts();
		const decisions = await Promise.all(
			Array.from({ length: 30 }, () => c.attempt("u")),
		);
		expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
		expect(decisions.filter((d) => d.audit)).toHaveLength(1);
	});
});
