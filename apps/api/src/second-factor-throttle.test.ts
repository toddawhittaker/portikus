import { describe, expect, test } from "vitest";
import {
	createSecondFactorCounts,
	SECOND_FACTOR_DAILY_LIMIT,
} from "./second-factor-throttle.js";

// SPEC.md section 24.13: ten wrong codes per account in ten minutes, and a
// daily cap, across every route that checks a code.
describe("createSecondFactorCounts", () => {
	const MINUTE = 60_000;

	test("refuses the eleventh try in ten minutes, audited once", () => {
		const counts = createSecondFactorCounts(() => 0);
		for (let i = 0; i < 10; i++) expect(counts.attempt("u").allowed).toBe(true);
		expect(counts.attempt("u")).toEqual({ allowed: false, audit: true, daily: false });
		expect(counts.attempt("u")).toEqual({ allowed: false, audit: false, daily: false });
		expect(counts.attempt("v").allowed).toBe(true);
	});

	test("caps a day at thirty wrong codes, telling the holder once", () => {
		let t = 0;
		const counts = createSecondFactorCounts(() => t);
		for (let i = 0; i < SECOND_FACTOR_DAILY_LIMIT; i++) {
			if (i > 0 && i % 10 === 0) t += 11 * MINUTE;
			expect(counts.attempt("u").allowed).toBe(true);
		}
		t += 11 * MINUTE;
		expect(counts.attempt("u")).toEqual({ allowed: false, audit: true, daily: true });
		t += 11 * MINUTE;
		expect(counts.attempt("u")).toEqual({ allowed: false, audit: false, daily: true });
		t += 24 * 60 * MINUTE;
		expect(counts.attempt("u").allowed).toBe(true);
	});

	test("refusals in a short window do not use up the day", () => {
		let t = 0;
		const counts = createSecondFactorCounts(() => t);
		for (let i = 0; i < 100; i++) counts.attempt("u");
		for (let w = 1; w < 3; w++) {
			t += 11 * MINUTE;
			for (let i = 0; i < 10; i++) expect(counts.attempt("u").allowed).toBe(true);
		}
	});

	test("a right code gives its try back to both counts", () => {
		let t = 0;
		const counts = createSecondFactorCounts(() => t);
		for (let w = 0; w < 5; w++) {
			for (let i = 0; i < 10; i++) {
				expect(counts.attempt("u").allowed).toBe(true);
				counts.giveBack("u");
			}
			t += 11 * MINUTE;
		}
	});
});
