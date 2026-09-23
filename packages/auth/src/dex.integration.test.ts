import { readFileSync } from "node:fs";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";
import { createOidcClient, OidcError } from "./oidc.js";
import { createSession, loadSession, upsertUser } from "./sessions.js";
import { type AuthOptions, mapRole } from "./types.js";

/**
 * Sign-in through a real Dex built from the pinned commit (docs/EPIC-12B.md,
 * Part A items 7 and 12). The CI dex-signin job starts Dex with the users
 * fixture rendered by infra/tests/dex-render-test.yml and sets DEX_TEST_ISSUER;
 * without it the suite is skipped.
 */
const ISSUER = process.env.DEX_TEST_ISSUER ?? "";

interface FixtureUser {
	username: string;
	email: string;
	displayName: string;
	role: "student" | "administrator";
	userId: string;
}

const fixture = JSON.parse(
	readFileSync(
		new URL("../../../infra/tests/fixtures/users.sample.json", import.meta.url),
		"utf8",
	),
) as { users: FixtureUser[] };
const byRole = (role: FixtureUser["role"]): FixtureUser => {
	const user = fixture.users.find((u) => u.role === role);
	if (!user) throw new Error(`the fixture has no ${role}`);
	return user;
};
const student = byRole("student");
const admin = byRole("administrator");
// Published on purpose with the fixture (.gitleaks.toml).
const FIXTURE_PASSWORD = "sample-password-not-secret";

// The values infra/tests/dex-render-test.yml renders into the Dex config.
const auth: AuthOptions = {
	publicUrl: "http://127.0.0.1:3000",
	issuerUrl: ISSUER,
	clientId: "portikus",
	clientSecret: "portikus-ci-dex-client-secret-not-a-real-one",
	scopes: "openid profile email groups",
	groupsClaim: "groups",
	studentGroup: "portikus-students",
	adminGroup: "portikus-administrators",
	instructorGroup: "portikus-instructors",
	cookieSecret: "a-test-cookie-secret-value",
	sessionTtlSeconds: 3600,
};
const CALLBACK = new URL("/auth/callback", auth.publicUrl).href;

/**
 * What a browser does between Portikus's redirect and the callback: follow
 * Dex to its password form, post it, and follow on. Returns the callback URL
 * when Dex sends the browser back, or null with the last page otherwise.
 */
async function submitPasswordForm(
	loginUrl: string,
	login: string,
	password: string,
): Promise<{ callback: URL | null; page: string }> {
	let url = loginUrl;
	let init: RequestInit = {};
	let posted = false;
	for (let hop = 0; hop < 10; hop++) {
		const res = await fetch(url, { ...init, redirect: "manual" });
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			const next = new URL(location, url);
			if (next.href.startsWith(CALLBACK)) return { callback: next, page: "" };
			url = next.href;
			init = {};
			continue;
		}
		const page = await res.text();
		if (posted) return { callback: null, page };
		const action = /<form method="post" action="([^"]*)"/.exec(page)?.[1];
		if (!action) throw new Error(`no password form at ${url} (status ${res.status})`);
		url = new URL(action.replaceAll("&amp;", "&"), url).href;
		init = {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ login, password }).toString(),
		};
		posted = true;
	}
	throw new Error("too many redirects");
}

describe.skipIf(!ISSUER)("sign-in through a real Dex", () => {
	const oidc = createOidcClient(auth);

	async function signIn(login: string, password: string) {
		const { url, state } = await oidc.buildLoginRedirect();
		const { callback, page } = await submitPasswordForm(url, login, password);
		if (!callback) return { completed: null, page };
		return { completed: await oidc.completeLogin(callback, state), page };
	}

	test("discovery names the issuer the test was given", async () => {
		const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
	});

	test("a student signs in with the subject Portikus predicts and the student role", async () => {
		const { completed } = await signIn(student.email, FIXTURE_PASSWORD);
		expect(completed).not.toBeNull();
		const { identity, claims } = completed ?? { identity: null, claims: {} };
		expect(identity).toEqual({
			issuer: ISSUER,
			subject: dexLocalSubject(student.userId),
			email: student.email,
			displayName: student.displayName,
			preferredUsername: student.username,
		});
		expect(mapRole(claims, auth)).toBe("student");
	});

	test("an administrator gets the administrator role from the group", async () => {
		const { completed } = await signIn(admin.email, FIXTURE_PASSWORD);
		expect(completed?.identity.subject).toBe(dexLocalSubject(admin.userId));
		expect(mapRole(completed?.claims ?? {}, auth)).toBe("administrator");
	});

	test("the login name is the email without regard to case", async () => {
		const { completed } = await signIn(student.email.toUpperCase(), FIXTURE_PASSWORD);
		expect(completed?.identity.subject).toBe(dexLocalSubject(student.userId));
	});

	test("a wrong password never reaches the callback", async () => {
		const { completed, page } = await signIn(student.email, "not-the-password-at-all");
		expect(completed).toBeNull();
		expect(page).toContain("Invalid");
	});

	test("an email that is not in the users file never reaches the callback", async () => {
		const { completed, page } = await signIn("nobody@example.edu", FIXTURE_PASSWORD);
		expect(completed).toBeNull();
		expect(page).toContain("Invalid");
	});

	test("a callback with a forged code is refused", async () => {
		const { state } = await oidc.buildLoginRedirect();
		const forged = new URL(CALLBACK);
		forged.searchParams.set("code", "forged");
		forged.searchParams.set("state", state.state);
		await expect(oidc.completeLogin(forged, state)).rejects.toBeInstanceOf(OidcError);
	});

	describe.skipIf(!hasTestDb())("with the Portikus database", () => {
		let t: TestDb;

		beforeAll(async () => {
			t = await createTestDb();
		});

		afterAll(async () => {
			await t?.close();
		});

		// The same steps as the API's /auth/callback, after completeLogin.
		async function sessionFor(login: string) {
			const { completed } = await signIn(login, FIXTURE_PASSWORD);
			if (!completed) throw new Error(`${login} could not sign in`);
			const role = mapRole(completed.claims, auth);
			if (!role) throw new Error(`${login} has no Portikus role`);
			const user = await upsertUser(t.db, completed.identity, role);
			return { user, session: await createSession(t.db, user.id, 3600) };
		}

		test("a signed-in user's row carries the Dex subject and the session loads", async () => {
			const { user, session } = await sessionFor(admin.email);
			const row = await t.db
				.selectFrom("users")
				.select(["oidc_issuer", "oidc_subject", "preferred_username", "role"])
				.where("id", "=", user.id)
				.executeTakeFirstOrThrow();
			expect(row).toEqual({
				oidc_issuer: ISSUER,
				oidc_subject: dexLocalSubject(admin.userId),
				preferred_username: admin.username,
				role: "administrator",
			});
			expect(await loadSession(t.db, session.token)).toMatchObject({
				id: user.id,
				role: "administrator",
			});
		});

		test("a disabled user signs in at Dex but Portikus refuses the session", async () => {
			const first = await sessionFor(student.email);
			await t.db
				.updateTable("users")
				.set({ disabled_at: new Date().toISOString() })
				.where("id", "=", first.user.id)
				.execute();
			expect(await loadSession(t.db, first.session.token)).toBeNull();

			const again = await sessionFor(student.email);
			expect(again.user.id).toBe(first.user.id);
			// The callback refuses a user with disabledAt set before making a session.
			expect(again.user.disabledAt).not.toBeNull();
			expect(await loadSession(t.db, again.session.token)).toBeNull();
		});
	});
});
