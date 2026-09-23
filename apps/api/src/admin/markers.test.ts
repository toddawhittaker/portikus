import { expect, test } from "vitest";
import { accountFlags, groupByEmail } from "./markers.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

test("an account without a sign-in for more than 30 days is stale", () => {
	const flags = accountFlags(
		[
			{ id: "a", email: "a@x", lastLoginAt: daysAgo(29) },
			{ id: "b", email: "b@x", lastLoginAt: daysAgo(31) },
			{ id: "c", email: null, lastLoginAt: null },
		],
		NOW,
	);
	expect(flags.get("a")).toEqual({ duplicateEmail: false, stale: false });
	expect(flags.get("b")).toEqual({ duplicateEmail: false, stale: true });
	expect(flags.get("c")).toEqual({ duplicateEmail: false, stale: true });
});

test("a shared email ignores case, and only the newest sign-in is not stale", () => {
	const flags = accountFlags(
		[
			{ id: "old", email: "Bob@X", lastLoginAt: daysAgo(2) },
			{ id: "new", email: "bob@x", lastLoginAt: daysAgo(1) },
		],
		NOW,
	);
	expect(flags.get("old")).toEqual({ duplicateEmail: true, stale: true });
	expect(flags.get("new")).toEqual({ duplicateEmail: true, stale: false });
});

test("accounts without an email are never duplicates of each other", () => {
	const flags = accountFlags(
		[
			{ id: "a", email: null, lastLoginAt: daysAgo(1) },
			{ id: "b", email: "", lastLoginAt: daysAgo(1) },
		],
		NOW,
	);
	expect(flags.get("a")?.duplicateEmail).toBe(false);
	expect(flags.get("b")?.duplicateEmail).toBe(false);
});

test("duplicates move up beside the first of them, and the rest keep their order", () => {
	const rows = [
		{ name: "Ann", email: "bob@x" },
		{ name: "Cy", email: null },
		{ name: "Dee", email: "dee@x" },
		{ name: "Zed", email: "BOB@x" },
	];
	expect(groupByEmail(rows).map((row) => row.name)).toEqual([
		"Ann",
		"Zed",
		"Cy",
		"Dee",
	]);
});
