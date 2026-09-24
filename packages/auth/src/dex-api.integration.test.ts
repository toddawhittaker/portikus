import { readFileSync } from "node:fs";
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
 * pinned commit (docs/EPIC-14.md rulings 20 to 22). The CI dex-signin job
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
