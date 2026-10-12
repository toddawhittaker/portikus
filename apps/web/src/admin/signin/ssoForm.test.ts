import type { SigninView } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	FIELD_ID,
	initialForm,
	jobText,
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

test("a trial put back because Portikus did not answer after setup says so", () => {
	expect(
		jobText({
			id: "11111111-1111-4111-8111-111111111111",
			kind: "signin",
			state: "reverted",
			code: "api_unhealthy",
			requestedAt: null,
			startedAt: null,
			finishedAt: null,
			trialEndsAt: null,
		}),
	).toBe(
		"Portikus did not answer after setup, so the earlier sign-in settings were put back.",
	);
});

const KEY = JSON.stringify({
	type: "service_account",
	project_id: "portikus-test",
	private_key_id: "fake-key-id",
	private_key:
		"-----BEGIN FAKE TEST KEY-----\nnot-a-real-key\n-----END FAKE TEST KEY-----\n",
	client_email: "groups@portikus-test.iam.gserviceaccount.com",
});

const GOOGLE_VIEW: SigninView = {
	...OIDC_VIEW,
	provider: "google",
	googleDomains: ["example.edu"],
	oidcIssuer: null,
	groupsClaim: null,
	googleAdminEmail: null,
	googleKeySet: false,
};

function googleGroups() {
	return {
		...initialForm(GOOGLE_VIEW),
		googleAdminEmail: "groups-reader@example.edu",
		googleKey: KEY,
		studentGroup: "Students@Example.edu",
		instructorGroup: "staff@example.edu",
		adminGroup: "it@example.edu",
	};
}

test("Google sends groups, and the key, only with an administrator", () => {
	expect(toSettings(initialForm(GOOGLE_VIEW))).not.toHaveProperty("groups");
	expect(
		toSettings({ ...initialForm(GOOGLE_VIEW), googleKey: KEY }),
	).not.toHaveProperty("googleServiceAccountKey");
	expect(toSettings(googleGroups())).toMatchObject({
		provider: "google",
		googleAdminEmail: "groups-reader@example.edu",
		googleServiceAccountKey: KEY,
		groups: {
			student: "Students@Example.edu",
			instructor: "staff@example.edu",
			admin: "it@example.edu",
		},
	});
	expect(toSettings({ ...googleGroups(), googleKey: "" })).not.toHaveProperty(
		"googleServiceAccountKey",
	);
});

test("Google group checks need a key unless one is stored", () => {
	const form = { ...googleGroups(), googleKey: "", clientSecret: "s".repeat(20) };
	expect(Object.keys(validate(form, GOOGLE_VIEW))).toEqual([FIELD_ID.googleKey]);
	expect(validate(form, { ...GOOGLE_VIEW, googleKeySet: true })).toEqual({});
	const user = JSON.stringify({ ...JSON.parse(KEY), type: "authorized_user" });
	expect(Object.keys(validate({ ...form, googleKey: user }, GOOGLE_VIEW))).toEqual([
		FIELD_ID.googleKey,
	]);
	const named = validate(
		{ ...form, adminGroup: "admins" },
		{ ...GOOGLE_VIEW, googleKeySet: true },
	);
	expect(named[FIELD_ID.adminGroup]).toContain("email address");
});

test("Entra sends groups only when roles come from groups, and wants object IDs", () => {
	const view: SigninView = {
		...OIDC_VIEW,
		provider: "entra",
		entraTenantId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
		oidcIssuer: null,
		groupsClaim: null,
		entraRoleSource: "appRoles",
	};
	const form = initialForm(view);
	expect(form.entraRoleSource).toBe("appRoles");
	expect(toSettings(form)).toMatchObject({ entraRoleSource: "appRoles" });
	expect(toSettings(form)).not.toHaveProperty("groups");
	const groups = {
		...form,
		entraRoleSource: "groups" as const,
		studentGroup: "0a1b2c3d-1111-4a5b-8c9d-000000000001",
		instructorGroup: "0a1b2c3d-1111-4a5b-8c9d-000000000002",
		adminGroup: "Portikus.Administrator",
	};
	expect(toSettings(groups)).toMatchObject({ entraRoleSource: "groups" });
	const errors = validate(groups, view);
	expect(Object.keys(errors)).toEqual([FIELD_ID.adminGroup]);
	expect(errors[FIELD_ID.adminGroup]).toContain("object ID");
});
