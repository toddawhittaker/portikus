import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
	createDexApi,
	type DexApi,
	generateDexPassword,
	hashDexPassword,
	loadDexApi,
} from "./dex-api.js";
import { dexLocalSubject } from "./dex-subject.js";
import { createOidcClient } from "./oidc.js";
import { submitDexPasswordForm } from "./testing/dex-signin.js";
import type { AuthOptions } from "./types.js";

/**
 * Dex user management through the gRPC API of a real Dex built from the
 * pinned commit (docs/archive/epics/EPIC-14.md rulings 20 to 22). The CI dex-signin job
 * starts Dex with PostgreSQL storage and the gRPC API behind mutual TLS, and
 * sets DEX_TEST_ISSUER and the DEX_GRPC_* settings; without them the suite
 * is skipped.
 */
const ISSUER = process.env.DEX_TEST_ISSUER ?? "";
const GRPC = {
	DEX_GRPC_ADDR: process.env.DEX_GRPC_ADDR,
	DEX_GRPC_CA: process.env.DEX_GRPC_CA,
	DEX_GRPC_CERT: process.env.DEX_GRPC_CERT,
	DEX_GRPC_KEY: process.env.DEX_GRPC_KEY,
};

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

describe.skipIf(!ISSUER || !GRPC.DEX_GRPC_ADDR)(
	"Dex users through the real gRPC API",
	() => {
		const oidc = createOidcClient(auth);
		let dex: DexApi;

		afterAll(() => dex?.close());

		async function signIn(login: string, password: string) {
			const { url, state } = await oidc.buildLoginRedirect();
			const { callback } = await submitDexPasswordForm(url, CALLBACK, login, password);
			return callback ? oidc.completeLogin(callback, state) : null;
		}

		test("creates, signs in as, resets and removes a user", async () => {
			dex = (await loadDexApi(GRPC)) as DexApi;
			const userId = crypto.randomUUID();
			const email = `grpc-${userId.slice(0, 8)}@example.edu`;
			const first = generateDexPassword();

			expect(
				await dex.createPassword({
					email,
					username: "grpc-user",
					userId,
					hash: await hashDexPassword(first),
				}),
			).toBe("created");
			expect(await dex.listPasswords()).toContainEqual({
				email,
				username: "grpc-user",
				userId,
			});
			expect(
				await dex.createPassword({
					email,
					username: "again",
					userId: crypto.randomUUID(),
					hash: await hashDexPassword(first),
				}),
			).toBe("already_exists");

			// The subject Portikus pre-creates the account under, the username as
			// the name, and no groups. Dex sends no preferred_username for a
			// password made through the API.
			const signedIn = await signIn(email, first);
			expect(signedIn?.identity.subject).toBe(dexLocalSubject(userId));
			expect(signedIn?.identity.displayName).toBe("grpc-user");
			expect(signedIn?.identity.preferredUsername).toBeNull();
			expect(signedIn?.claims.groups ?? []).toEqual([]);

			const second = generateDexPassword();
			expect(await dex.updatePassword(email, await hashDexPassword(second))).toBe(
				"updated",
			);
			expect(await signIn(email, first)).toBeNull();
			expect((await signIn(email, second))?.identity.subject).toBe(
				dexLocalSubject(userId),
			);

			expect(await dex.deletePassword(email)).toBe("deleted");
			expect(await signIn(email, second)).toBeNull();
			expect(await dex.deletePassword(email)).toBe("not_found");
		});

		test("refuses a client whose certificate Dex's authority did not sign", async () => {
			const ca = readFileSync(GRPC.DEX_GRPC_CA ?? "");
			const stranger = createDexApi({
				address: GRPC.DEX_GRPC_ADDR ?? "",
				ca,
				cert: readFileSync(process.env.DEX_GRPC_OTHER_CERT ?? ""),
				key: readFileSync(process.env.DEX_GRPC_OTHER_KEY ?? ""),
			});
			try {
				await expect(stranger.listPasswords()).rejects.toThrow();
			} finally {
				stranger.close();
			}
		});
	},
);

/**
 * The local administrator and a password an administrator made, through the
 * real API in front of the real Dex (SPEC.md sections 5.1 to 5.3, ADR 0031).
 * The CI job starts the built API on DEX_TEST_API_URL with
 * the Dex above as its issuer and its gRPC API, on the database
 * DEX_TEST_API_DATABASE_URL names; without them the suite is skipped.
 */
const API = process.env.DEX_TEST_API_URL ?? "";
const API_DATABASE_URL = process.env.DEX_TEST_API_DATABASE_URL ?? "";

describe.skipIf(!ISSUER || !GRPC.DEX_GRPC_ADDR || !API || !API_DATABASE_URL)(
	"passwords that must be changed, through the real API and Dex",
	() => {
		const apiCallback = `${API}/auth/callback`;
		const adminEmail = "local-admin@example.edu";

		function cookiesOf(res: Response): string {
			return res.headers
				.getSetCookie()
				.map((c) => c.split(";")[0] ?? "")
				.filter((c) => !c.endsWith("="))
				.join("; ");
		}

		/** The API's sign-in, as a browser does it: the session cookie, or null. */
		async function apiSignIn(login: string, password: string): Promise<string | null> {
			const start = await fetch(`${API}/auth/login`, { redirect: "manual" });
			const location = start.headers.get("location");
			if (start.status !== 302 || !location) throw new Error("no redirect to Dex");
			const { callback } = await submitDexPasswordForm(
				location,
				apiCallback,
				login,
				password,
			);
			if (!callback) return null;
			const done = await fetch(callback, {
				redirect: "manual",
				headers: { cookie: cookiesOf(start) },
			});
			if (done.status !== 302 || done.headers.get("location") !== "/") {
				throw new Error(`the callback answered ${done.status}`);
			}
			return cookiesOf(done);
		}

		async function me(cookie: string | null) {
			const res = await fetch(`${API}/auth/me`, { headers: { cookie: cookie ?? "" } });
			expect(res.status).toBe(200);
			return (await res.json()) as Record<string, unknown>;
		}

		function post(cookie: string | null, path: string, body: unknown) {
			return fetch(`${API}${path}`, {
				method: "POST",
				// The browser's own origin, which the API requires on a change.
				headers: {
					cookie: cookie ?? "",
					"content-type": "application/json",
					origin: API,
				},
				body: JSON.stringify(body),
			});
		}

		/** The built command, as `portikus reset-admin` runs it on the VM. */
		function resetAdmin(): string {
			const main = fileURLToPath(
				new URL("../dist/reset-admin-main.js", import.meta.url),
			);
			const out = execFileSync(process.execPath, [main, "--email", adminEmail], {
				env: {
					...process.env,
					DATABASE_URL: API_DATABASE_URL,
					OIDC_ISSUER_URL: ISSUER,
					PUBLIC_URL: API,
				},
				encoding: "utf8",
			});
			// Standard output holds the password and nothing else.
			const lines = out.split("\n").filter(Boolean);
			expect(lines).toHaveLength(1);
			return lines[0] ?? "";
		}

		test("the local administrator signs in with the printed password, changes it, and the old one stops working", async () => {
			const first = resetAdmin();
			const cookie = await apiSignIn(adminEmail, first);
			expect(cookie).not.toBeNull();
			expect(await me(cookie)).toMatchObject({
				role: "administrator",
				mustChangePassword: true,
				localPassword: true,
			});
			// Everything but the change is closed while the flag is set.
			const blocked = await fetch(`${API}/admin/users`, {
				headers: { cookie: cookie ?? "" },
			});
			expect(blocked.status).toBe(403);
			expect(await blocked.json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });

			// Dex's VerifyPassword refuses a wrong current password.
			const second = "a-brand-new-password-for-ci";
			const wrong = await post(cookie, "/me/password", {
				currentPassword: `${first}x`,
				newPassword: second,
			});
			expect(wrong.status).toBe(403);
			expect(await wrong.json()).toMatchObject({ code: "WRONG_PASSWORD" });

			const changed = await post(cookie, "/me/password", {
				currentPassword: first,
				newPassword: second,
			});
			expect(changed.status, await changed.text()).toBeLessThan(300);
			expect(await me(cookie)).toMatchObject({ mustChangePassword: false });

			expect(await apiSignIn(adminEmail, first)).toBeNull();
			const again = await apiSignIn(adminEmail, second);
			expect(again).not.toBeNull();
			expect(await me(again)).toMatchObject({
				role: "administrator",
				mustChangePassword: false,
			});
		});

		test("a password made by Add user must be changed at first sign-in", async () => {
			const cookie = await apiSignIn(adminEmail, "a-brand-new-password-for-ci");
			expect(cookie).not.toBeNull();
			const email = `added-${crypto.randomUUID().slice(0, 8)}@example.edu`;
			const added = await post(cookie, "/admin/dex-users", {
				email,
				username: "added-user",
				name: "Added User",
				role: "student",
			});
			expect(added.status).toBe(200);
			const { password } = (await added.json()) as { password: string };
			const newcomer = await apiSignIn(email, password);
			expect(newcomer).not.toBeNull();
			expect(await me(newcomer)).toMatchObject({
				role: "student",
				mustChangePassword: true,
				localPassword: true,
			});
		});
	},
);
