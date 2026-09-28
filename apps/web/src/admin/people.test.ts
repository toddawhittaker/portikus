import type { AdminUser } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	PERSON_AMBIGUOUS_TEXT,
	PERSON_LOADING_TEXT,
	PERSON_UNKNOWN_TEXT,
	personLabel,
	personOptions,
	resolvePerson,
	workspaceLabel,
} from "./people.js";

const WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function user(id: string, displayName: string, email: string | null): AdminUser {
	return {
		id,
		displayName,
		email,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		preferredUsername: null,
		issuer: null,
		lastLoginAt: null,
		markers: {
			disabled: false,
			archived: false,
			duplicateEmail: false,
			stale: false,
			linked: false,
		},
		workspace: null,
		dexLocal: false,
	} as AdminUser;
}

const ADA = user(
	"11111111-1111-4111-8111-111111111111",
	"Ada Lovelace",
	"ada@example.edu",
);
const SAM_A = user(
	"22222222-2222-4222-8222-222222222222",
	"Sam Lee",
	"sam.a@example.edu",
);
const SAM_B = user("33333333-3333-4333-8333-333333333333", "Sam Lee", null);
const USERS = [
	{ ...ADA, workspace: { id: WS } as AdminUser["workspace"] },
	SAM_A,
	SAM_B,
];
const OPTIONS = personOptions(USERS);

test("a unique name is offered as itself; a shared one gains the email or a short ID", () => {
	expect(OPTIONS.map((option) => option.label)).toEqual([
		"Ada Lovelace",
		"Sam Lee (33333333)",
		"Sam Lee (sam.a@example.edu)",
	]);
});

test("a chosen or typed name, label or email becomes the user's ID", () => {
	expect(resolvePerson("Ada Lovelace", USERS)).toEqual({ id: ADA.id });
	expect(resolvePerson("  ada lovelace ", USERS)).toEqual({ id: ADA.id });
	expect(resolvePerson("ADA@example.edu", USERS)).toEqual({ id: ADA.id });
	expect(resolvePerson("Sam Lee (sam.a@example.edu)", USERS)).toEqual({
		id: SAM_A.id,
	});
	expect(resolvePerson("", USERS)).toEqual({ id: "" });
});

test("a shared name alone, or no match, asks for a choice from the list", () => {
	expect(resolvePerson("Sam Lee", USERS)).toEqual({
		error: PERSON_AMBIGUOUS_TEXT,
	});
	expect(resolvePerson("Grace", USERS)).toEqual({
		error: PERSON_UNKNOWN_TEXT,
	});
});

test("a full ID in any case still works, for a pasted link", () => {
	const other = "44444444-4444-4444-8444-444444444444";
	expect(resolvePerson(other, USERS)).toEqual({ id: other });
	expect(resolvePerson(other.toUpperCase(), undefined)).toEqual({ id: other });
});

test("a username matches too", () => {
	const carol = {
		...user("55555555-5555-4555-8555-555555555555", "Carol Admin", null),
		preferredUsername: "carol",
	};
	expect(resolvePerson("CAROL", [...USERS, carol])).toEqual({ id: carol.id });
});

test("a name typed before the list loads asks to wait, not that no one matches", () => {
	expect(resolvePerson("Ada Lovelace", undefined)).toEqual({
		error: PERSON_LOADING_TEXT,
	});
	expect(resolvePerson(" ", undefined)).toEqual({ id: "" });
});

test("an ID from the URL shows as the person's label, or as itself when unknown", () => {
	expect(personLabel(OPTIONS, ADA.id)).toBe("Ada Lovelace");
	expect(personLabel(OPTIONS, "not-listed")).toBe("not-listed");
});

test("a workspace filter names its owner", () => {
	expect(workspaceLabel(OPTIONS, WS)).toBe("Only Ada Lovelace's workspace");
	expect(workspaceLabel(OPTIONS, "bbbbbbbb-0000-4000-8000-000000000000")).toBe(
		"Only workspace bbbbbbbb",
	);
});
