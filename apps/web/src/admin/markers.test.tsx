import type { AdminUser } from "@portikus/contracts";
import { expect, test } from "vitest";
import { logCommand } from "./logCommand.js";
import {
	imageText,
	isCourseAccount,
	markerLabels,
	roleText,
	shortIssuer,
	sortAccounts,
	sourceText,
} from "./markers.js";

const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	linked: false,
};

function account(
	id: string,
	displayName: string,
	email: string | null,
	markers = NONE,
): AdminUser {
	return {
		id,
		displayName,
		email,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		dexLocal: false,
		preferredUsername: null,
		issuer: null,
		lastLoginAt: null,
		markers,
		workspace: null,
	};
}

test("marker labels come in a fixed order and only when set", () => {
	expect(markerLabels(undefined)).toEqual([]);
	expect(markerLabels(NONE)).toEqual([]);
	expect(
		markerLabels({
			disabled: true,
			archived: true,
			duplicateEmail: true,
			stale: true,
			linked: true,
		}),
	).toEqual(["Disabled", "Archived", "Linked", "Duplicate email", "Stale"]);
	expect(markerLabels({ ...NONE, linked: true })).toEqual(["Linked"]);
	expect(markerLabels({ ...NONE, stale: true })).toEqual(["Stale"]);
});

test("accounts that share an email sit together, whatever their names (issue #302)", () => {
	const dup = { ...NONE, duplicateEmail: true };
	const sorted = sortAccounts([
		account("1", "Zed Old", "Bob@Example.edu", dup),
		account("2", "Alice", "alice@example.edu"),
		account("3", "Bob New", "bob@example.edu", dup),
		account("4", "Carol", null),
	]);
	expect(sorted.map((user) => user.displayName)).toEqual([
		"Alice",
		"Bob New",
		"Zed Old",
		"Carol",
	]);
});

test("the image reads as current, older, or just its label", () => {
	expect(imageText({ label: "2026.09.9", fingerprint: "abc", current: true })).toBe(
		"2026.09.9 · current",
	);
	expect(imageText({ label: "abcdef012345", fingerprint: "abc", current: false })).toBe(
		"abcdef012345 · older",
	);
	expect(imageText({ label: "2026.09.9", fingerprint: "abc", current: null })).toBe(
		"2026.09.9",
	);
	expect(imageText({ label: null, fingerprint: null, current: null })).toBe("Unknown");
});

test("an issuer is shortened to its host", () => {
	expect(shortIssuer("https://login.example.edu/realms/students")).toBe(
		"login.example.edu",
	);
	expect(shortIssuer(null)).toBe("—");
	expect(shortIssuer("not a url at all, and rather long")).toBe(
		"not a url at all, and ra…",
	);
});

test("the log command greps for the workspace id and the instance name", () => {
	expect(logCommand("w-1", "ws-abc")).toBe(
		"journalctl -u portikus-api -u portikus-worker -u portikus-workspace-controller -o cat --since -1h | grep -E 'w-1|ws-abc'",
	);
	expect(logCommand("w-1", null)).toMatch(/grep -E 'w-1'$/);
});

test("the source is SSO, or Course with the platform host for a course account", () => {
	expect(sourceText("https://login.example.edu")).toBe("SSO");
	expect(sourceText(null)).toBe("SSO");
	expect(sourceText("lti:https://canvas.example.edu")).toBe(
		"Course: canvas.example.edu",
	);
	expect(isCourseAccount("lti:https://canvas.example.edu")).toBe(true);
	expect(isCourseAccount("https://login.example.edu")).toBe(false);
});

test("role labels say where an administrator's role came from", () => {
	expect(roleText({ role: "administrator", grantedRole: null })).toBe(
		"Administrator (from SSO)",
	);
	expect(roleText({ role: "administrator", grantedRole: "administrator" })).toBe(
		"Administrator (granted)",
	);
	expect(roleText({ role: "instructor", grantedRole: null })).toBe("Instructor");
	expect(roleText({ role: "student", grantedRole: null })).toBe("Student");
});
