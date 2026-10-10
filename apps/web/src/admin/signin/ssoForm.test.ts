import type { SigninView } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	FIELD_ID,
	initialForm,
	secretRequired,
	timeLeft,
	toSettings,
	validate,
} from "./ssoForm.js";

const OIDC_VIEW: SigninView = {
	provider: "oidc",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: "https://login.example.edu",
	clientId: "portikus",
	clientSecretSet: true,
	groupsClaim: "groups",
	groups: { student: "students", instructor: "teachers", admin: "admins" },
};

test("the form starts from the settings in force, and from Dex only for LDAP", () => {
	expect(initialForm(OIDC_VIEW)).toMatchObject({
		provider: "oidc",
		oidcIssuer: "https://login.example.edu",
		clientSecret: "",
		instructorGroup: "teachers",
	});
	expect(initialForm({ ...OIDC_VIEW, provider: "ldap" }).provider).toBe("dex");
});

test("only the chosen provider's fields are sent, and a blank secret is null", () => {
	const form = { ...initialForm(OIDC_VIEW), provider: "google" as const };
	expect(toSettings({ ...form, googleDomains: "a.edu, b.edu  c.edu" })).toEqual({
		provider: "google",
		googleDomains: ["a.edu", "b.edu", "c.edu"],
		clientId: "portikus",
		clientSecret: null,
	});
	expect(
		toSettings({ ...form, provider: "dex", clientSecret: "x".repeat(20) }),
	).toEqual({
		provider: "dex",
		clientSecret: null,
	});
});

test("a stored secret is kept only for the same provider, tenant, issuer and client", () => {
	const form = initialForm(OIDC_VIEW);
	expect(secretRequired(form, OIDC_VIEW)).toBe(false);
	expect(secretRequired({ ...form, clientId: "other" }, OIDC_VIEW)).toBe(true);
	expect(
		secretRequired({ ...form, oidcIssuer: "https://x.example.edu" }, OIDC_VIEW),
	).toBe(true);
	expect(secretRequired({ ...form, provider: "google" }, OIDC_VIEW)).toBe(true);
	expect(secretRequired(form, { ...OIDC_VIEW, clientSecretSet: false })).toBe(true);
	expect(secretRequired({ ...form, provider: "dex" }, null)).toBe(false);
});

test("validate names the field to fix, with the API's own rules", () => {
	const form = initialForm(OIDC_VIEW);
	expect(validate(form, OIDC_VIEW)).toEqual({});
	expect(
		Object.keys(
			validate(
				{ ...form, oidcIssuer: "http://x", clientSecret: "s".repeat(16) },
				OIDC_VIEW,
			),
		),
	).toEqual([FIELD_ID.oidcIssuer]);
	expect(Object.keys(validate({ ...form, instructorGroup: 'a"b' }, OIDC_VIEW))).toEqual(
		[FIELD_ID.instructorGroup],
	);
	expect(Object.keys(validate({ ...form, clientSecret: "short" }, OIDC_VIEW))).toEqual([
		FIELD_ID.clientSecret,
	]);
	expect(Object.keys(validate({ ...form, clientId: "new" }, OIDC_VIEW))).toEqual([
		FIELD_ID.clientSecret,
	]);
	const entra = { ...form, provider: "entra" as const, clientSecret: "s".repeat(16) };
	expect(Object.keys(validate(entra, OIDC_VIEW))).toEqual([FIELD_ID.entraTenantId]);
});

test("the countdown shows minutes and seconds, never below zero", () => {
	const now = Date.parse("2026-10-10T12:00:00Z");
	expect(timeLeft("2026-10-10T12:29:05Z", now)).toBe("29:05");
	expect(timeLeft("2026-10-10T11:00:00Z", now)).toBe("0:00");
});
