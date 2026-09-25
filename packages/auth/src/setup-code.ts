import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * The one-time setup code that makes its claimer the first administrator
 * (docs/EPIC-14.md rulings 15 to 18; ADR 0028). Sixteen Crockford base-32
 * characters, 80 random bits, valid for an hour, single use. Only the
 * SHA-256 of a code is stored: with 80 random bits a slow hash adds nothing.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;
export const SETUP_CODE_TTL_MINUTES = 60;

/** A new code, as four groups of four separated by hyphens. */
export function generateSetupCode(): string {
	const bytes = randomBytes(10);
	let bits = 0n;
	for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
	let code = "";
	for (let i = CODE_LENGTH - 1; i >= 0; i--) {
		code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
	}
	return [0, 4, 8, 12].map((at) => code.slice(at, at + 4)).join("-");
}

/**
 * The code a person typed, in the one form that is hashed, or null when it
 * cannot be a code. Case, spaces and hyphens do not matter, and the letters
 * Crockford reads as digits (O, I and L) count as those digits.
 */
export function normalizeSetupCode(input: string): string | null {
	const code = input
		.toUpperCase()
		.replace(/[\s-]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
	if (code.length !== CODE_LENGTH) return null;
	for (const ch of code) if (!ALPHABET.includes(ch)) return null;
	return code;
}

function hashSetupCode(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Issue a new code, deleting any unused one, and audit `setup.code_issued`
 * without the code. Returns the code to show once.
 */
export async function issueSetupCode(
	db: Kysely<Database>,
	now: Date = new Date(),
): Promise<string> {
	const code = generateSetupCode();
	const expiresAt = new Date(now.getTime() + SETUP_CODE_TTL_MINUTES * 60_000);
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("setup_codes").where("used_at", "is", null).execute();
		await trx
			.insertInto("setup_codes")
			.values({
				code_hash: hashSetupCode(normalizeSetupCode(code) as string),
				created_at: now.toISOString(),
				expires_at: expiresAt.toISOString(),
			})
			.execute();
		await trx
			.insertInto("audit_events")
			.values({
				actor: "system",
				target: "setup",
				action: "setup.code_issued",
				result: "ok",
				metadata: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
			})
			.execute();
	});
	return code;
}

/**
 * Mark a good, unexpired, unused code as used by `userId`. Returns false for
 * anything else, without saying why. Run inside the caller's transaction so
 * the code and what it grants commit together.
 */
export async function claimSetupCode(
	trx: Kysely<Database>,
	input: string,
	userId: string | null,
	now: Date = new Date(),
): Promise<boolean> {
	const normalized = normalizeSetupCode(input);
	if (normalized === null) return false;
	const row = await trx
		.updateTable("setup_codes")
		.set({ used_at: now.toISOString(), used_by: userId })
		.where("code_hash", "=", hashSetupCode(normalized))
		.where("used_at", "is", null)
		.where("expires_at", ">", now)
		.returning("id")
		.executeTakeFirst();
	return row !== undefined;
}

/** Whether any enabled account is an administrator. */
export async function hasEnabledAdministrator(db: Kysely<Database>): Promise<boolean> {
	const row = await db
		.selectFrom("users")
		.select("id")
		.where("role", "=", "administrator")
		.where("disabled_at", "is", null)
		.executeTakeFirst();
	return row !== undefined;
}
