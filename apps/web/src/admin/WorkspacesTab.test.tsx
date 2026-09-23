import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import { expect, test } from "vitest";
import { filterAccounts, lastActivity, NO_FILTERS, timeAgo } from "./WorkspacesTab.js";

const NONE = { disabled: false, archived: false, duplicateEmail: false, stale: false };

function summary(
	overrides: Partial<AdminWorkspaceSummary> = {},
): AdminWorkspaceSummary {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		label: "alice",
		state: "running",
		desiredState: "running",
		activeConnections: 0,
		lastActiveConnectionAt: null,
		quotaConfig: { homeGiB: 25, dockerGiB: 20 },
		quotaApplied: { homeGiB: 25, dockerGiB: 20 },
		image: { label: "2026.09.9", fingerprint: "abc", current: true },
		archivedAt: null,
		...overrides,
	};
}

function account(
	displayName: string,
	workspace: AdminWorkspaceSummary | null,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return {
		id: `${displayName}-id`,
		displayName,
		email: `${displayName.toLowerCase()}@example.edu`,
		role: "student",
		disabledAt: null,
		shutdownGraceSeconds: null,
		preferredUsername: displayName.toLowerCase(),
		issuer: null,
		lastLoginAt: null,
		markers: NONE,
		workspace,
		...extra,
	};
}

const alice = account("Alice", summary());
const bob = account(
	"Bob",
	summary({
		label: "bobby",
		state: "stopped",
		image: { label: "old", fingerprint: "x", current: false },
	}),
);
const carol = account("Carol", null);
const dave = account(
	"Dave",
	summary({ label: "dave", archivedAt: "2026-09-01T00:00:00.000Z" }),
	{
		markers: { ...NONE, archived: true },
	},
);
const all = [alice, bob, carol, dave];

function names(users: AdminUser[]): string[] {
	return users.map((user) => user.displayName);
}

test("archived rows are hidden unless asked for", () => {
	expect(names(filterAccounts(all, NO_FILTERS))).toEqual(["Alice", "Bob", "Carol"]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, showArchived: true }))).toEqual([
		"Alice",
		"Bob",
		"Carol",
		"Dave",
	]);
});

test("the text filter matches name, email, username and workspace label", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "BOBBY" }))).toEqual(["Bob"]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "carol@" }))).toEqual([
		"Carol",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, text: "  " }))).toEqual([
		"Alice",
		"Bob",
		"Carol",
	]);
});

test("the state filter picks a state, or accounts with no workspace", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, state: "stopped" }))).toEqual([
		"Bob",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, state: "none" }))).toEqual([
		"Carol",
	]);
});

test("the image filter picks current or older", () => {
	expect(names(filterAccounts(all, { ...NO_FILTERS, image: "current" }))).toEqual([
		"Alice",
	]);
	expect(names(filterAccounts(all, { ...NO_FILTERS, image: "older" }))).toEqual([
		"Bob",
	]);
});

test("last activity is Now while connected, otherwise the time since", () => {
	const now = Date.parse("2026-09-22T12:00:00.000Z");
	expect(lastActivity(summary({ activeConnections: 2 }), now)).toBe("Now");
	expect(
		lastActivity(summary({ lastActiveConnectionAt: "2026-09-22T11:56:00.000Z" }), now),
	).toBe("4 min ago");
	expect(timeAgo("2026-09-22T09:00:00.000Z", now)).toBe("3 h ago");
	expect(timeAgo("2026-09-21T11:00:00.000Z", now)).toBe("1 day ago");
	expect(timeAgo("2026-08-22T11:00:00.000Z", now)).toBe("31 days ago");
	expect(timeAgo("2026-09-22T11:59:40.000Z", now)).toBe("Just now");
	expect(timeAgo(null, now)).toBe("—");
});
