import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";
import {
	checkPasskey,
	createChallengeStore,
	parsePasskey,
	passkeyAuthenticationOptions,
	passkeyRegistrationOptions,
	relyingParty,
	type StoredPasskey,
	verifyPasskeyRegistration,
} from "./passkey.js";
import { SoftPasskey } from "./testing/soft-passkey.js";

/** Passkeys as a second factor (SPEC.md section 24.13). */

const rp = relyingParty("https://portikus.example.edu");
const USER = {
	id: "6f1c1a8e-1d3b-4b7e-9a51-1d2c3b4a5e6f",
	name: "ada",
	displayName: "Ada",
};

async function registered(key: SoftPasskey): Promise<StoredPasskey> {
	const options = await passkeyRegistrationOptions(rp, USER, []);
	const result = await verifyPasskeyRegistration(
		rp,
		key.register(options),
		options.challenge,
	);
	if (!result) throw new Error("registration did not verify");
	return result.passkey;
}

describe("the relying party", () => {
	test("is the public host, with the exact origin", () => {
		expect(relyingParty("https://portikus.example.edu:8443/x")).toEqual({
			id: "portikus.example.edu",
			origin: "https://portikus.example.edu:8443",
			name: "Portikus",
		});
	});
});

describe("registration", () => {
	test("options name the host, prefer verification and exclude known passkeys", async () => {
		const options = await passkeyRegistrationOptions(rp, USER, [
			{ credentialId: "abc", publicKey: "def", transports: ["usb"] },
		]);
		expect(options.rp).toEqual({ id: "portikus.example.edu", name: "Portikus" });
		expect(options.authenticatorSelection?.userVerification).toBe("preferred");
		expect(options.excludeCredentials).toEqual([
			{ id: "abc", type: "public-key", transports: ["usb"] },
		]);
	});

	test("a good answer gives the credential id, public key and transports", async () => {
		const key = new SoftPasskey(rp.origin);
		const passkey = await registered(key);
		expect(passkey.credentialId).toBe(key.credentialId);
		expect(passkey.transports).toEqual(["internal"]);
		expect(parsePasskey(JSON.stringify(passkey))).toEqual(passkey);
	});

	test("another origin, another challenge or another host is refused", async () => {
		const key = new SoftPasskey(rp.origin);
		const options = await passkeyRegistrationOptions(rp, USER, []);
		const otherOrigin = key.register(options, "https://portikus.example.edu.evil.test");
		expect(
			await verifyPasskeyRegistration(rp, otherOrigin, options.challenge),
		).toBeNull();
		const answer = key.register(options);
		expect(await verifyPasskeyRegistration(rp, answer, "another-challenge")).toBeNull();
		const elsewhere = relyingParty("https://elsewhere.example.edu");
		expect(
			await verifyPasskeyRegistration(elsewhere, answer, options.challenge),
		).toBeNull();
	});

	test("a stored record that is not a passkey parses to null", () => {
		expect(parsePasskey("v1:sealed-totp")).toBeNull();
		expect(parsePasskey("{}")).toBeNull();
	});
});

describe("challenges", () => {
	test("each is taken once", () => {
		const store = createChallengeStore(60_000);
		store.put("s:verify", "c1", 0);
		expect(store.take("s:verify", 1)).toBe("c1");
		expect(store.take("s:verify", 2)).toBeNull();
	});

	test("an expired one is refused", () => {
		const store = createChallengeStore(60_000);
		store.put("s:verify", "c1", 0);
		expect(store.take("s:verify", 60_000)).toBeNull();
	});

	test("a new one replaces the old for the same session and ceremony", () => {
		const store = createChallengeStore(60_000);
		store.put("s:verify", "c1", 0);
		store.put("s:verify", "c2", 1);
		store.put("s:register", "c3", 1);
		expect(store.take("s:verify", 2)).toBe("c2");
		expect(store.take("s:register", 2)).toBe("c3");
	});
});

describe.skipIf(!hasTestDb())("signing in with a passkey", () => {
	let t: TestDb;
	let userId: string;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: "https://dex.example.edu",
				oidc_subject: dexLocalSubject("ada"),
				display_name: "Ada",
				role: "student",
				provider_role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		userId = row.id;
	});

	async function store(passkey: StoredPasskey, counter = 0): Promise<string> {
		const row = await t.db
			.insertInto("user_second_factors")
			.values({
				user_id: userId,
				kind: "webauthn",
				secret: JSON.stringify(passkey),
				label: "Laptop",
				last_step: counter,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function signIn(key: SoftPasskey, passkey: StoredPasskey) {
		const options = await passkeyAuthenticationOptions(rp, [passkey]);
		return checkPasskey(t.db, rp, userId, key.authenticate(options), options.challenge);
	}

	test("a good answer passes and stores the new sign count", async () => {
		const key = new SoftPasskey(rp.origin);
		const passkey = await registered(key);
		const id = await store(passkey);
		expect(await signIn(key, passkey)).toEqual({ ok: true, factorId: id });
		const row = await t.db
			.selectFrom("user_second_factors")
			.select(["last_step", "last_used_at"])
			.executeTakeFirstOrThrow();
		expect(Number(row.last_step)).toBe(1);
		expect(row.last_used_at).not.toBeNull();
		expect((await signIn(key, passkey)).ok).toBe(true);
	});

	test("a sign count that goes backwards is refused as a copied key", async () => {
		const key = new SoftPasskey(rp.origin);
		const passkey = await registered(key);
		await store(passkey, 5);
		key.counter = 3;
		expect(await signIn(key, passkey)).toEqual({ ok: false, reason: "cloned" });
		key.counter = 4;
		// Counts up to 5, which equals the stored count: still refused.
		expect(await signIn(key, passkey)).toEqual({ ok: false, reason: "cloned" });
		expect((await signIn(key, passkey)).ok).toBe(true);
	});

	test("the same answer twice is refused the second time", async () => {
		const key = new SoftPasskey(rp.origin);
		const passkey = await registered(key);
		await store(passkey);
		const options = await passkeyAuthenticationOptions(rp, [passkey]);
		const answer = key.authenticate(options);
		const first = await checkPasskey(t.db, rp, userId, answer, options.challenge);
		const again = await checkPasskey(t.db, rp, userId, answer, options.challenge);
		expect(first.ok).toBe(true);
		expect(again).toEqual({ ok: false, reason: "cloned" });
	});

	test("another account's passkey, a wrong origin or a wrong challenge is refused", async () => {
		const key = new SoftPasskey(rp.origin);
		const passkey = await registered(key);
		await store(passkey);
		const stranger = new SoftPasskey(rp.origin);
		const strangerKey = await registered(stranger);
		expect(await signIn(stranger, strangerKey)).toEqual({
			ok: false,
			reason: "unknown",
		});

		const options = await passkeyAuthenticationOptions(rp, [passkey]);
		const phished = key.authenticate(options, "https://evil.example");
		expect(await checkPasskey(t.db, rp, userId, phished, options.challenge)).toEqual({
			ok: false,
			reason: "invalid",
		});
		const answer = key.authenticate(options);
		expect(await checkPasskey(t.db, rp, userId, answer, "stale")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});
});
