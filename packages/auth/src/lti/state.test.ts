import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	checkLaunchState,
	consumeLoginState,
	hashState,
	ltiStateCookieName,
	ltiStateCookieOptions,
	readLtiStateCookie,
	saveLoginState,
} from "./state.js";

describe("checkLaunchState", () => {
	test.each([
		[undefined, "abc", "state_missing"],
		["abc", undefined, "state_missing"],
		["", "", "state_missing"],
		["abc", "abd", "state_mismatch"],
		["abc", "abcd", "state_mismatch"],
		["abc", "abc", null],
	])("form %j and cookie %j give %j", (form, cookie, expected) => {
		expect(checkLaunchState(form, cookie)).toBe(expected);
	});
});

describe("the state cookie", () => {
	test("is a __Host- cookie named from the state's hash", () => {
		expect(ltiStateCookieName("abc")).toBe(
			"__Host-portikus_lti_state_ba7816bf8f01cfea",
		);
		expect(ltiStateCookieOptions()).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "none",
			path: "/",
			maxAge: 600,
		});
	});

	test("two states get two cookies, and each launch reads only its own", () => {
		const cookies = {
			[ltiStateCookieName("one")]: "one",
			[ltiStateCookieName("two")]: "two",
		};
		expect(ltiStateCookieName("one")).not.toBe(ltiStateCookieName("two"));
		expect(readLtiStateCookie(cookies, "one")).toBe("one");
		expect(readLtiStateCookie(cookies, "two")).toBe("two");
		expect(readLtiStateCookie(cookies, "three")).toBeUndefined();
	});
});

test("hashState is SHA-256 hex, never the state itself", () => {
	expect(hashState("abc")).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
});

describe("login state store", () => {
	let t: TestDb;
	let db: Kysely<Database>;
	const now = new Date("2026-09-23T12:00:00Z");
	const input = {
		state: "state-1",
		nonce: "nonce-1",
		platformIssuer: "https://lms.example.edu",
		clientId: "c1",
	};

	beforeAll(async () => {
		if (!hasTestDb()) return;
		t = await createTestDb();
		db = t.db;
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		if (hasTestDb()) await db.deleteFrom("lti_login_states").execute();
	});

	test.skipIf(!hasTestDb())("stores the hash, not the state", async () => {
		await saveLoginState(db, input, now);
		const rows = await db.selectFrom("lti_login_states").selectAll().execute();
		expect(rows).toEqual([
			{
				state_hash: hashState("state-1"),
				nonce: "nonce-1",
				platform_issuer: "https://lms.example.edu",
				client_id: "c1",
				expires_at: new Date("2026-09-23T12:10:00Z"),
			},
		]);
	});

	test.skipIf(!hasTestDb())("a state is consumed once", async () => {
		await saveLoginState(db, input, now);
		expect(await consumeLoginState(db, "state-1", now)).toEqual({
			nonce: "nonce-1",
			platformIssuer: "https://lms.example.edu",
			clientId: "c1",
		});
		expect(await consumeLoginState(db, "state-1", now)).toBeNull();
	});

	test.skipIf(!hasTestDb())("two concurrent launches: only one wins", async () => {
		await saveLoginState(db, input, now);
		const results = await Promise.all([
			consumeLoginState(db, "state-1", now),
			consumeLoginState(db, "state-1", now),
		]);
		expect(results.filter((r) => r !== null)).toHaveLength(1);
	});

	test.skipIf(!hasTestDb())("an unknown or expired state is null", async () => {
		await saveLoginState(db, input, now);
		expect(await consumeLoginState(db, "other", now)).toBeNull();
		const later = new Date(now.getTime() + 600_000);
		expect(await consumeLoginState(db, "state-1", later)).toBeNull();
	});

	test.skipIf(!hasTestDb())("saving clears expired rows", async () => {
		await saveLoginState(db, input, now);
		const later = new Date(now.getTime() + 600_000);
		await saveLoginState(db, { ...input, state: "state-2" }, later);
		const rows = await db.selectFrom("lti_login_states").select("state_hash").execute();
		expect(rows).toEqual([{ state_hash: hashState("state-2") }]);
	});
});
