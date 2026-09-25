import { readFileSync } from "node:fs";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";
import { createOidcClient, OidcError } from "./oidc.js";
import { createSession, loadSession, upsertUser } from "./sessions.js";
import {
	signInThroughDexUpstream,
	submitDexPasswordForm,
} from "./testing/dex-signin.js";
import { type AuthOptions, mapRole } from "./types.js";

/**
 * Sign-in through a real Dex built from the pinned commit (docs/archive/epics/EPIC-12B.md,
 * Part A items 7 and 12). The CI dex-signin job starts Dex with the
 * configuration infra/tests/dex-render-test.yml renders, imports the users
 * fixture through dex-import-main.ts as the dex role does (docs/archive/epics/EPIC-14.md
 * ruling 23), and sets DEX_TEST_ISSUER; without it the suite is skipped.
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
	// As Ansible sets it under Dex (docs/archive/epics/EPIC-14.md ruling 11).
	defaultRole: "student",
	cookieSecret: "a-test-cookie-secret-value",
	sessionTtlSeconds: 3600,
};
const CALLBACK = new URL("/auth/callback", auth.publicUrl).href;

describe.skipIf(!ISSUER)("sign-in through a real Dex", () => {
	const oidc = createOidcClient(auth);

	async function signIn(login: string, password: string) {
		const { url, state } = await oidc.buildLoginRedirect();
		const { callback, page } = await submitDexPasswordForm(
			url,
			CALLBACK,
			login,
			password,
		);
		if (!callback) return { completed: null, page };
		return { completed: await oidc.completeLogin(callback, state), page };
	}

	test("discovery names the issuer the test was given", async () => {
		const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
	});

	test("an imported student signs in with the subject the users file gave and the student role", async () => {
		const { completed } = await signIn(student.email, FIXTURE_PASSWORD);
		expect(completed).not.toBeNull();
		const { identity, claims } = completed ?? { identity: null, claims: {} };
		// A password made through the gRPC API has no name of its own, and Dex
		// sends no preferred_username for it.
		expect(identity).toEqual({
			issuer: ISSUER,
			subject: dexLocalSubject(student.userId),
			email: student.email,
			displayName: student.username,
			preferredUsername: null,
		});
		expect(mapRole(claims, auth)).toBe("student");
	});

	test("an imported administrator keeps the subject and gets no group from Dex", async () => {
		const { completed } = await signIn(admin.email, FIXTURE_PASSWORD);
		expect(completed?.identity.subject).toBe(dexLocalSubject(admin.userId));
		expect(completed?.claims.groups ?? []).toEqual([]);
		expect(mapRole(completed?.claims ?? {}, auth)).toBe("student");
	});

	test("the login name is the email without regard to case", async () => {
		const { completed } = await signIn(student.email.toUpperCase(), FIXTURE_PASSWORD);
		expect(completed?.identity.subject).toBe(dexLocalSubject(student.userId));
	});

	test("a wrong password never reaches the callback", async () => {
		const { completed, page } = await signIn(student.email, "not-the-password-at-all");
		expect(completed).toBeNull();
		expect(page).toContain("or password is wrong.");
	});

	test("an email Dex holds no password for never reaches the callback", async () => {
		const { completed, page } = await signIn("nobody@example.edu", FIXTURE_PASSWORD);
		expect(completed).toBeNull();
		expect(page).toContain("or password is wrong.");
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
			return {
				user,
				session: await createSession(t.db, user.id, 3600, {
					method: "oidc",
					courseUserId: null,
				}),
			};
		}

		test("an administrator's existing row, with the import's grant, is signed into as administrator", async () => {
			// The row the users file's accounts already had, with the grant the
			// import sets because Dex sends no group for them.
			const existing = await t.db
				.insertInto("users")
				.values({
					oidc_issuer: ISSUER,
					oidc_subject: dexLocalSubject(admin.userId),
					email: admin.email,
					display_name: admin.displayName,
					preferred_username: admin.username,
					role: "administrator",
					granted_role: "administrator",
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			const { user, session } = await sessionFor(admin.email);
			expect(user.id).toBe(existing.id);
			const row = await t.db
				.selectFrom("users")
				.select(["preferred_username", "role", "provider_role", "granted_role"])
				.where("id", "=", user.id)
				.executeTakeFirstOrThrow();
			expect(row).toEqual({
				preferred_username: admin.username,
				role: "administrator",
				provider_role: "student",
				granted_role: "administrator",
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

/**
 * Sign-in through a real Dex whose one upstream connector is the mock
 * provider (SPEC.md sections 5.1 and 5.2). The CI job renders the dex
 * role's template from infra/tests/fixtures/dex-upstream-mock.yml, once as
 * the generic `oidc` connector and once as the `entra` preset, and sets
 * DEX_TEST_UPSTREAM to which one and DEX_TEST_UPSTREAM_ISSUER to Dex.
 */
const UPSTREAM = process.env.DEX_TEST_UPSTREAM ?? "";
const UPSTREAM_ISSUER = process.env.DEX_TEST_UPSTREAM_ISSUER ?? "";

describe.skipIf(!UPSTREAM_ISSUER || !["oidc", "entra"].includes(UPSTREAM))(
	`sign-in through a real Dex with the ${UPSTREAM} connector`,
	() => {
		const entra = UPSTREAM === "entra";
		// The api.env lines site.yml writes for this upstream.
		const upstreamAuth: AuthOptions = {
			...auth,
			issuerUrl: UPSTREAM_ISSUER,
			studentGroup: entra ? "Portikus.Student" : "portikus-students",
			adminGroup: entra ? "Portikus.Administrator" : "portikus-administrators",
			instructorGroup: entra ? "Portikus.Instructor" : "portikus-instructors",
		};
		const oidc = createOidcClient(upstreamAuth);

		async function signIn(mockUser: string) {
			const { url, state } = await oidc.buildLoginRedirect();
			const { callback, page } = await signInThroughDexUpstream(
				url,
				CALLBACK,
				UPSTREAM,
				mockUser,
			);
			if (!callback) return { completed: null, page };
			return { completed: await oidc.completeLogin(callback, state), page };
		}

		test("carol is an administrator by her upstream group", async () => {
			const { completed, page } = await signIn("carol");
			expect(completed, page).not.toBeNull();
			expect(completed?.identity).toMatchObject({
				issuer: UPSTREAM_ISSUER,
				email: "carol@example.edu",
				displayName: "Carol Admin",
			});
			expect(completed?.claims.groups).toEqual([upstreamAuth.adminGroup]);
			expect(mapRole(completed?.claims ?? {}, upstreamAuth)).toBe("administrator");
		});

		// erin has a student group and, for Entra, the student app role.
		test("a student signs in as a student", async () => {
			const { completed, page } = await signIn(entra ? "erin" : "alice");
			expect(completed, page).not.toBeNull();
			expect(completed?.claims.groups).toEqual([upstreamAuth.studentGroup]);
			expect(mapRole(completed?.claims ?? {}, upstreamAuth)).toBe("student");
		});

		test("dave, with no group and no app role, is refused by Dex", async () => {
			const { completed } = await signIn("dave");
			expect(completed).toBeNull();
		});

		// Behind Entra only app roles count: alice's directory groups are not
		// passed on, so she has none of the three and Dex refuses her.
		test.runIf(entra)(
			"alice, with groups but no app role, is refused by Dex",
			async () => {
				const { completed } = await signIn("alice");
				expect(completed).toBeNull();
			},
		);
	},
);
