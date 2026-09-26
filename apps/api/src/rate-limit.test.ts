import { describe, expect, test } from "vitest";
import { check, createCounter } from "./rate-limit.js";

describe("the fixed-window counter (docs/EPIC-17.md ruling 15)", () => {
	function fixture(limit = 3, windowMs = 60_000) {
		let clock = 1_000_000;
		const counter = createCounter(limit, windowMs, () => clock);
		return { counter, advance: (ms: number) => (clock += ms) };
	}

	test("lets the limit through and refuses the next one, for that key only", () => {
		const { counter } = fixture();
		for (let i = 0; i < 3; i++) expect(check(counter, "u1").allowed).toBe(true);
		expect(check(counter, "u1").allowed).toBe(false);
		expect(check(counter, "u2").allowed).toBe(true);
	});

	test("reports the first refusal of a window once", () => {
		const { counter } = fixture(1);
		check(counter, "u1");
		expect(check(counter, "u1").firstRefusal).toBe(true);
		expect(check(counter, "u1").firstRefusal).toBe(false);
	});

	test("says how long until the window ends", () => {
		const { counter, advance } = fixture(1);
		check(counter, "u1");
		advance(15_500);
		expect(check(counter, "u1").retryAfterSeconds).toBe(45);
		advance(44_000);
		expect(check(counter, "u1").retryAfterSeconds).toBe(1);
	});

	test("a new window starts afresh", () => {
		const { counter, advance } = fixture(1);
		check(counter, "u1");
		expect(check(counter, "u1").allowed).toBe(false);
		advance(60_000);
		expect(check(counter, "u1")).toEqual({
			allowed: true,
			firstRefusal: false,
			retryAfterSeconds: 0,
		});
	});

	test("a preview page of 2,000 assets fits one window; a runaway loop does not", () => {
		const { counter } = fixture(2000, 10_000);
		for (let i = 0; i < 2000; i++) expect(check(counter, "s").allowed).toBe(true);
		expect(check(counter, "s").allowed).toBe(false);
	});
});
