import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Single-use links for emailed password reset and invitations (SPEC.md
 * section 5.3). A token is 32 random bytes; only its SHA-256 is stored, so a
 * database read alone cannot use a link. Never log or audit a token.
 */

export type AccountEmailPurpose = "reset" | "invite";

/** A reset link lasts 30 minutes, an invitation 7 days. */
export const TOKEN_LIFETIME_MS: Record<AccountEmailPurpose, number> = {
	reset: 30 * 60_000,
	invite: 7 * 24 * 60 * 60_000,
};

/** 32 bytes in base64url without padding is always 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function hashAccountEmailToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export interface IssuedAccountEmailToken {
	/** The row id, the only thing an audit row may hold. */
	id: string;
	/** Goes into the emailed link and nowhere else. */
	token: string;
	expiresAt: Date;
}

/**
 * Issue a new link. Older links stay live until the caller knows this one
 * reached the mailbox, then calls supersedeAccountEmailTokens.
 */
export async function issueAccountEmailToken(
	db: Kysely<Database>,
	input: {
		userId: string;
		purpose: AccountEmailPurpose;
		/** The administrator who sent it; null when the account holder asked. */
		createdBy: string | null;
		now?: Date;
	},
): Promise<IssuedAccountEmailToken> {
	const now = input.now ?? new Date();
	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS[input.purpose]);
	const row = await db
		.insertInto("account_email_tokens")
		.values({
			user_id: input.userId,
			purpose: input.purpose,
			token_hash: hashAccountEmailToken(token),
			created_by: input.createdBy,
			created_at: now,
			expires_at: expiresAt,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: row.id, token, expiresAt };
}

/**
 * Revoke every other live link a newly sent one replaces: a reset link
 * replaces older reset and invitation links, an invitation older invitations.
 */
export async function supersedeAccountEmailTokens(
	db: Kysely<Database>,
	input: { userId: string; purpose: AccountEmailPurpose; keepId: string; now?: Date },
): Promise<void> {
	const purposes: AccountEmailPurpose[] =
		input.purpose === "reset" ? ["reset", "invite"] : ["invite"];
	await db
		.updateTable("account_email_tokens")
		.set({ revoked_at: input.now ?? new Date() })
		.where("user_id", "=", input.userId)
		.where("purpose", "in", purposes)
		.where("id", "<>", input.keepId)
		.where("used_at", "is", null)
		.where("revoked_at", "is", null)
		.execute();
}

/**
 * Use a link once. Answers null for a token that is malformed, unknown, for
 * another purpose, expired, revoked or already used; the caller must not say which.
 */
export async function consumeAccountEmailToken(
	db: Kysely<Database>,
	token: string,
	purpose: AccountEmailPurpose,
	now: Date = new Date(),
): Promise<{ id: string; userId: string } | null> {
	if (!TOKEN_SHAPE.test(token)) return null;
	// One statement, so two requests racing on the same link cannot both win.
	const row = await db
		.updateTable("account_email_tokens")
		.set({ used_at: now })
		.where("token_hash", "=", hashAccountEmailToken(token))
		.where("purpose", "=", purpose)
		.where("used_at", "is", null)
		.where("revoked_at", "is", null)
		.where("expires_at", ">", now)
		.returning(["id", "user_id"])
		.executeTakeFirst();
	return row ? { id: row.id, userId: row.user_id } : null;
}

/** Revoke every live link of an account: on a password change, removal, disable or email change. */
export async function revokeAccountEmailTokens(
	db: Kysely<Database>,
	userId: string,
	now: Date = new Date(),
): Promise<void> {
	await db
		.updateTable("account_email_tokens")
		.set({ revoked_at: now })
		.where("user_id", "=", userId)
		.where("used_at", "is", null)
		.where("revoked_at", "is", null)
		.execute();
}

/** Delete links that can no longer be used. Returns how many rows went. */
export async function pruneEndedAccountEmailTokens(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const result = await db
		.deleteFrom("account_email_tokens")
		.where((eb) =>
			eb.or([
				eb("expires_at", "<=", now),
				eb("used_at", "is not", null),
				eb("revoked_at", "is not", null),
			]),
		)
		.executeTakeFirst();
	return Number(result.numDeletedRows);
}
