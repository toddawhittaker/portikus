import { describe, expect, test } from "vitest";
import { digestDue, latestMondayEight } from "./week.js";

// Local-time constructors, so the tests hold in any server time zone.
const local = (day: number, hour = 0, minute = 0) =>
	new Date(2026, 10, day, hour, minute);
// 16 November 2026 is a Monday.
const MONDAY_EIGHT = local(16, 8);

describe("latestMondayEight", () => {
	test("on Monday at 08:00 sharp is that moment", () => {
		expect(latestMondayEight(local(16, 8)).getTime()).toBe(MONDAY_EIGHT.getTime());
	});

	test("on Monday before 08:00 is the Monday before", () => {
		expect(latestMondayEight(local(16, 7, 59)).getTime()).toBe(local(9, 8).getTime());
	});

	test("on Wednesday and on Sunday night is the same Monday", () => {
		expect(latestMondayEight(local(18, 15)).getTime()).toBe(MONDAY_EIGHT.getTime());
		expect(latestMondayEight(local(22, 23, 59)).getTime()).toBe(MONDAY_EIGHT.getTime());
	});
});

describe("digestDue", () => {
	test("is due when nothing was ever sent", () => {
		expect(digestDue(null, local(18, 15))).toBe(true);
	});

	test("is not due before Monday 08:00 when last week's was sent", () => {
		expect(digestDue(local(9, 8, 1), local(16, 7, 59))).toBe(false);
	});

	test("is due once Monday 08:00 passes", () => {
		expect(digestDue(local(9, 8, 1), local(16, 8))).toBe(true);
	});

	test("is not due again after it was sent this week, even after a restart", () => {
		expect(digestDue(local(16, 8, 2), local(16, 8, 30))).toBe(false);
		expect(digestDue(local(16, 8, 2), local(22, 23, 59))).toBe(false);
	});

	test("a missed week is due once, not once per missed Monday", () => {
		const last = local(2, 8, 1);
		expect(digestDue(last, local(18, 15))).toBe(true);
		// After the single catch-up send, it is quiet until the next Monday.
		expect(digestDue(local(18, 15, 1), local(19, 9))).toBe(false);
		expect(digestDue(local(18, 15, 1), local(23, 8))).toBe(true);
	});
});
