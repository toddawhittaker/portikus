import { expect, test } from "vitest";
import { accountFlags, groupByEmail } from "./markers.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const OLD = daysAgo(400);

test("an account without a sign-in for more than 30 days is stale", () => {
	const flags = accountFlags(
		[
			{ id: "a", email: "a@x", lastLoginAt: daysAgo(29), createdAt: OLD },
			{ id: "b", email: "b@x", lastLoginAt: daysAgo(31), createdAt: OLD },
		],
		NOW,
	);
	expect(flags.get("a")).toEqual({
		duplicateEmail: false,
		stale: false,
		notSignedInYet: false,
	});
	expect(flags.get("b")).toEqual({
		duplicateEmail: false,
		stale: true,
		notSignedInYet: false,
	});
});

test("a new account that never signed in is not stale, only not signed in yet", () => {
	const flags = accountFlags(
		[{ id: "new", email: "n@x", lastLoginAt: null, createdAt: daysAgo(0) }],
		NOW,
	);
	expect(flags.get("new")).toEqual({
		duplicateEmail: false,
		stale: false,
		notSignedInYet: true,
	});
});

test("a never-signed-in account created more than 30 days ago is stale", () => {
	const flags = accountFlags(
		[{ id: "c", email: null, lastLoginAt: null, createdAt: daysAgo(31) }],
		NOW,
	);
	expect(flags.get("c")).toEqual({
		duplicateEmail: false,
		stale: true,
		notSignedInYet: false,
	});
});

test("a new never-signed-in account is still stale beside a twin that signed in", () => {
	const flags = accountFlags(
		[
			{ id: "fresh", email: "t@x", lastLoginAt: null, createdAt: daysAgo(0) },
			{ id: "twin", email: "T@x", lastLoginAt: daysAgo(1), createdAt: OLD },
		],
		NOW,
	);
	expect(flags.get("fresh")).toEqual({
		duplicateEmail: true,
		stale: true,
		notSignedInYet: false,
	});
	expect(flags.get("twin")?.stale).toBe(false);
});

test("a shared email ignores case, and only the newest sign-in is not stale", () => {
	const flags = accountFlags(
		[
			{ id: "old", email: "Bob@X", lastLoginAt: daysAgo(2), createdAt: OLD },
			{ id: "new", email: "bob@x", lastLoginAt: daysAgo(1), createdAt: OLD },
		],
		NOW,
	);
	expect(flags.get("old")?.stale).toBe(true);
	expect(flags.get("new")?.stale).toBe(false);
});

test("accounts without an email are never duplicates of each other", () => {
	const flags = accountFlags(
		[
			{ id: "a", email: null, lastLoginAt: daysAgo(1), createdAt: OLD },
			{ id: "b", email: "", lastLoginAt: daysAgo(1), createdAt: OLD },
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
