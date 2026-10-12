import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	consumeAccountEmailToken,
	hashAccountEmailToken,
	issueAccountEmailToken,
	pruneEndedAccountEmailTokens,
	revokeAccountEmailTokens,
	supersedeAccountEmailTokens,
	TOKEN_LIFETIME_MS,
} from "./tokens.js";

/** Emailed links work once, expire, and are stored only as hashes (SPEC.md section 5.3). */

const skip = !hasTestDb();

test("a reset link lasts 30 minutes and an invitation 7 days", () => {
	expect(TOKEN_LIFETIME_MS.reset).toBe(30 * 60_000);
	expect(TOKEN_LIFETIME_MS.invite).toBe(7 * 24 * 60 * 60_000);
});

describe.skipIf(skip)("account email tokens", () => {
	let t: TestDb;
	let userId: string;
	const now = new Date("2026-10-12T12:00:00Z");

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
				oidc_issuer: "urn:portikus:dex",
				oidc_subject: "token-owner",
				email: "owner@example.test",
				display_name: "Owner",
				role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		userId = row.id;
	});

	const issue = (purpose: "reset" | "invite" = "reset", at = now) =>
		issueAccountEmailToken(t.db, { userId, purpose, createdBy: null, now: at });

	test("a token is 32 random bytes in base64url and only its SHA-256 is stored", async () => {
		const issued = await issue();
		expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(issued.token, "base64url")).toHaveLength(32);
		expect(issued.expiresAt).toEqual(new Date(now.getTime() + TOKEN_LIFETIME_MS.reset));
		const rows = await t.db.selectFrom("account_email_tokens").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.token_hash).toBe(hashAccountEmailToken(issued.token));
		expect(JSON.stringify(rows)).not.toContain(issued.token);
	});

	test("a token works once", async () => {
		const { id, token } = await issue();
		expect(await consumeAccountEmailToken(t.db, token, "reset", now)).toEqual({
			id,
			userId,
		});
		expect(await consumeAccountEmailToken(t.db, token, "reset", now)).toBeNull();
	});

	test("a token stops working when it expires", async () => {
		const { token } = await issue();
		const end = new Date(now.getTime() + TOKEN_LIFETIME_MS.reset);
		expect(await consumeAccountEmailToken(t.db, token, "reset", end)).toBeNull();
		const before = new Date(end.getTime() - 1000);
		expect(await consumeAccountEmailToken(t.db, token, "reset", before)).not.toBeNull();
	});

	test("an invitation token is no reset token, and a malformed or unknown token is refused", async () => {
		const { token } = await issue("invite");
		expect(await consumeAccountEmailToken(t.db, token, "reset", now)).toBeNull();
		expect(await consumeAccountEmailToken(t.db, "short", "invite", now)).toBeNull();
		expect(
			await consumeAccountEmailToken(t.db, "A".repeat(43), "invite", now),
		).toBeNull();
		expect(await consumeAccountEmailToken(t.db, token, "invite", now)).not.toBeNull();
	});

	test("issuing alone revokes nothing; superseding a reset ends older resets and invitations", async () => {
		const firstReset = await issue("reset");
		const invite = await issue("invite");
		const secondReset = await issue("reset");
		const check = async (token: string, purpose: "reset" | "invite") =>
			t.db
				.selectFrom("account_email_tokens")
				.select("revoked_at")
				.where("token_hash", "=", hashAccountEmailToken(token))
				.where("purpose", "=", purpose)
				.executeTakeFirstOrThrow();
		expect((await check(firstReset.token, "reset")).revoked_at).toBeNull();
		await supersedeAccountEmailTokens(t.db, {
			userId,
			purpose: "reset",
			keepId: secondReset.id,
			now,
		});
		expect(
			await consumeAccountEmailToken(t.db, invite.token, "invite", now),
		).toBeNull();
		expect(
			await consumeAccountEmailToken(t.db, firstReset.token, "reset", now),
		).toBeNull();
		expect(
			await consumeAccountEmailToken(t.db, secondReset.token, "reset", now),
		).not.toBeNull();
	});

	test("superseding an invitation leaves reset links alone", async () => {
		const reset = await issue("reset");
		const first = await issue("invite");
		const second = await issue("invite");
		await supersedeAccountEmailTokens(t.db, {
			userId,
			purpose: "invite",
			keepId: second.id,
			now,
		});
		expect(await consumeAccountEmailToken(t.db, first.token, "invite", now)).toBeNull();
		expect(
			await consumeAccountEmailToken(t.db, reset.token, "reset", now),
		).not.toBeNull();
	});

	test("revoking an account's links ends every live one", async () => {
		const reset = await issue("reset");
		const invite = await issue("invite");
		await revokeAccountEmailTokens(t.db, userId, now);
		expect(await consumeAccountEmailToken(t.db, reset.token, "reset", now)).toBeNull();
		expect(
			await consumeAccountEmailToken(t.db, invite.token, "invite", now),
		).toBeNull();
	});

	test("the prune deletes used, revoked and expired links and keeps live ones", async () => {
		const row = (hash: string, ended: Record<string, Date>) => ({
			user_id: userId,
			purpose: "reset" as const,
			token_hash: hash,
			expires_at: new Date(now.getTime() + 60_000),
			...ended,
		});
		await t.db
			.insertInto("account_email_tokens")
			.values([
				row("used", { used_at: now }),
				row("revoked", { revoked_at: now }),
				row("expired", { expires_at: now }),
				row("live", {}),
			])
			.execute();
		expect(await pruneEndedAccountEmailTokens(t.db, now)).toBe(3);
		const left = await t.db
			.selectFrom("account_email_tokens")
			.select("token_hash")
			.execute();
		expect(left).toEqual([{ token_hash: "live" }]);
	});
});
