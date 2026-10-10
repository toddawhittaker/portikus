import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import { expect, test } from "vitest";
import { queryAdminUsers } from "./users-query.js";

const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	notSignedInYet: false,
	linked: false,
};

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
		pendingOperation: null,
		cpuThrottle: null,
		memoryFlag: null,
		...overrides,
	} as AdminWorkspaceSummary;
}

function account(
	name: string,
	workspace: AdminWorkspaceSummary | null,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return {
		id: `${name}-id`,
		displayName: name,
		email: `${name.toLowerCase()}@example.edu`,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		dexLocal: false,
		preferredUsername: name.toLowerCase(),
		issuer: "https://sso.example",
		lastLoginAt: null,
		markers: NONE,
		workspace,
		...extra,
	};
}

const ada = account("Ada", summary({ state: "running", activeConnections: 2 }), {
	role: "administrator",
	providerRole: "administrator",
});
const ben = account(
	"Ben",
	summary({
		id: "bbbbbbbb-0000-4000-8000-000000000000",
		label: "ben-lab",
		state: "stopped",
		image: { label: "old", fingerprint: "x", current: false },
		lastActiveConnectionAt: "2026-09-30T10:00:00.000Z",
	}),
);
const cy = account("Cy", null, {
	role: "instructor",
	providerRole: "instructor",
	issuer: "lti:https://lms.example.edu",
});
const dee = account(
	"Dee",
	summary({
		state: "error",
		archivedAt: "2026-10-01T10:00:00.000Z",
		pendingOperation: "rebuild",
	}),
	{ markers: { ...NONE, archived: true } },
);
const all = [ada, ben, cy, dee];

function names(result: { users: AdminUser[] }): string[] {
	return result.users.map((user) => user.displayName);
}

test("no limit returns every account, archived ones only when asked for", () => {
	expect(names(queryAdminUsers(all, {}))).toEqual(["Ada", "Ben", "Cy"]);
	expect(names(queryAdminUsers(all, { archived: "1" }))).toEqual([
		"Ada",
		"Ben",
		"Cy",
		"Dee",
	]);
});

test("search reads names, email, username, source and workspace, ignoring case", () => {
	expect(names(queryAdminUsers(all, { q: " BEN-LAB " }))).toEqual(["Ben"]);
	expect(names(queryAdminUsers(all, { q: "course: lms.example.edu" }))).toEqual(["Cy"]);
	expect(names(queryAdminUsers(all, { q: "sso" }))).toEqual(["Ada", "Ben"]);
	expect(names(queryAdminUsers(all, { q: "ada@" }))).toEqual(["Ada"]);
	expect(names(queryAdminUsers(all, { q: "22222222" }))).toEqual(["Ada"]);
});

test("role, state and image filters", () => {
	expect(names(queryAdminUsers(all, { role: "instructor" }))).toEqual(["Cy"]);
	expect(names(queryAdminUsers(all, { state: "stopped" }))).toEqual(["Ben"]);
	expect(names(queryAdminUsers(all, { state: "none" }))).toEqual(["Cy"]);
	expect(names(queryAdminUsers(all, { image: "older" }))).toEqual(["Ben"]);
	expect(names(queryAdminUsers(all, { image: "current" }))).toEqual(["Ada"]);
});

test("pending keeps only accounts with an operation pending, archived or not", () => {
	expect(names(queryAdminUsers(all, { pending: "1" }))).toEqual(["Dee"]);
});

test("unlinkedCourse keeps only course accounts with no link, whatever the search", () => {
	const eve = account("Eve", null, {
		issuer: "lti:https://lms.example.edu",
		markers: { ...NONE, linked: true },
	});
	const accounts = [...all, eve];
	expect(names(queryAdminUsers(accounts, { unlinkedCourse: "1" }))).toEqual(["Cy"]);
	expect(
		names(queryAdminUsers(accounts, { unlinkedCourse: "1", q: "course" })),
	).toEqual(["Cy"]);
	expect(names(queryAdminUsers(accounts, { unlinkedCourse: "1", q: "ben" }))).toEqual(
		[],
	);
});

test("sorts by account, role, workspace and activity, blanks last either way", () => {
	expect(names(queryAdminUsers(all, { dir: "descending" }))).toEqual([
		"Cy",
		"Ben",
		"Ada",
	]);
	expect(names(queryAdminUsers(all, { sort: "role", dir: "ascending" }))).toEqual([
		"Ada",
		"Cy",
		"Ben",
	]);
	expect(names(queryAdminUsers(all, { sort: "workspace" }))).toEqual([
		"Ada",
		"Ben",
		"Cy",
	]);
	expect(names(queryAdminUsers(all, { sort: "workspace", dir: "descending" }))).toEqual(
		["Ben", "Ada", "Cy"],
	);
	expect(names(queryAdminUsers(all, { sort: "activity", dir: "descending" }))).toEqual([
		"Ada",
		"Ben",
		"Cy",
	]);
	expect(names(queryAdminUsers(all, { sort: "activity", dir: "ascending" }))).toEqual([
		"Ben",
		"Ada",
		"Cy",
	]);
});

test("a page is cut after filtering and sorting, and total counts every match", () => {
	const many = Array.from({ length: 120 }, (_, n) =>
		account(`User${String(n).padStart(3, "0")}`, null),
	);
	const first = queryAdminUsers(many, { limit: 50 });
	expect(first.total).toBe(120);
	expect(first.users).toHaveLength(50);
	const last = queryAdminUsers(many, { limit: 50, offset: 100 });
	expect(last.users).toHaveLength(20);
	expect(last.users[0]?.displayName).toBe("User100");
	const filtered = queryAdminUsers(many, { q: "user01", limit: 5, offset: 5 });
	expect(filtered.total).toBe(10);
	expect(names(filtered)).toEqual([
		"User015",
		"User016",
		"User017",
		"User018",
		"User019",
	]);
	expect(queryAdminUsers(many, {}).users).toHaveLength(120);
});
