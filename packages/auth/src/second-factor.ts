import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
	randomInt,
} from "node:crypto";
import { type Database, recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";
import { dexLocalUserId } from "./dex-subject.js";
import { sha256Hex } from "./hash.js";
import { isCourseIssuer } from "./links.js";
import { matchTotp } from "./totp.js";

/**
 * The second factor of Dex local-password accounts (SPEC.md section
 * 24.13): TOTP secrets sealed at rest, single-use recovery codes, and the
 * reset an administrator or `reset-admin` uses. Nothing here logs a
 * secret or a code.
 */

const SEALED_PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const RECOVERY_CODE_COUNT = 10;
/** How long a started enrolment may wait for its first code. */
const ENROL_TTL_MS = 10 * 60_000;

/**
 * The key that seals TOTP secrets, derived from the session cookie secret
 * so the install needs no new secret. Rotating that secret makes every
 * enrolled factor unreadable, and the holders must be reset.
 */
export function secondFactorKey(platformSecret: string): Buffer {
	return Buffer.from(
		hkdfSync("sha256", platformSecret, "", "portikus second factor secrets v1", 32),
	);
}

/**
 * AES-256-GCM with `context` as additional data, so a sealed value only
 * opens for the account and purpose it was made for.
 */
export function sealSecret(key: Buffer, plaintext: Buffer, context: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(context, "utf8"));
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return (
		SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
	);
}

/** The plaintext of `sealSecret`, or null when the value, key or context is wrong. */
export function openSecret(
	key: Buffer,
	sealed: string,
	context: string,
): Buffer | null {
	if (!sealed.startsWith(SEALED_PREFIX)) return null;
	const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64url");
	if (raw.length < IV_BYTES + TAG_BYTES) return null;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(context, "utf8"));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		return Buffer.concat([
			decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
			decipher.final(),
		]);
	} catch {
		return null;
	}
}

function storedContext(userId: string): string {
	return `totp:${userId}`;
}

function pendingContext(userId: string, expiresAt: number): string {
	return `totp-pending:${userId}:${expiresAt}`;
}

/**
 * A started enrolment: the new secret sealed for this account with its
 * expiry, so the server keeps nothing until the first code proves the
 * authenticator holds it.
 */
export function sealPendingTotp(
	key: Buffer,
	userId: string,
	secret: Buffer,
	nowMs: number,
): string {
	const expiresAt = nowMs + ENROL_TTL_MS;
	return `${expiresAt}.${sealSecret(key, secret, pendingContext(userId, expiresAt))}`;
}

/** The secret of a started enrolment, or null when it is expired, forged or another account's. */
export function openPendingTotp(
	key: Buffer,
	userId: string,
	token: string,
	nowMs: number,
): Buffer | null {
	const dot = token.indexOf(".");
	const expiresAt = Number(token.slice(0, dot));
	if (dot < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) return null;
	return openSecret(key, token.slice(dot + 1), pendingContext(userId, expiresAt));
}

// No 0, O, 1, I or L, which people misread when typing a code from paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Sixteen characters from 31, about 79 bits, shown as four groups of four. */
function recoveryCode(): string {
	let raw = "";
	for (let i = 0; i < 16; i++)
		raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
	return raw.match(/.{4}/g)?.join("-") ?? raw;
}

export function generateRecoveryCodes(): string[] {
	return Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
}

/**
 * The stored form of a recovery code. The codes are long and random, so a
 * plain SHA-256 is enough; spaces, dashes and case are ignored.
 */
export function hashRecoveryCode(code: string): string {
	return sha256Hex(code.replace(/[\s-]/g, "").toUpperCase());
}

export interface EnrolTotpInput {
	userId: string;
	secret: Buffer;
	label: string;
	/** The step of the code that confirmed it, so that code cannot be used again. */
	step: number;
	/** The session that enrolled, which has passed the check by doing so. */
	sessionId: string;
	actor: string;
	metadata: Record<string, unknown>;
}

/** A confirmed factor of either kind, as `storeFactor` writes it. */
export interface NewFactor {
	userId: string;
	kind: "totp" | "webauthn";
	/** The sealed TOTP secret, or a passkey's public record. */
	secret: string;
	label: string;
	/** The last TOTP step, or a passkey's sign count. */
	lastStep: number;
	/** The session that enrolled, which has passed the check by doing so. */
	sessionId: string;
	actor: string;
	metadata: Record<string, unknown>;
}

/** Replace an account's recovery codes inside a transaction; returns the new ones in plain text. */
async function writeRecoveryCodes(
	trx: Kysely<Database>,
	userId: string,
): Promise<string[]> {
	const codes = generateRecoveryCodes();
	await trx.deleteFrom("user_recovery_codes").where("user_id", "=", userId).execute();
	await trx
		.insertInto("user_recovery_codes")
		.values(
			codes.map((code) => ({ user_id: userId, code_hash: hashRecoveryCode(code) })),
		)
		.execute();
	return codes;
}

/**
 * Store a confirmed factor and a fresh set of recovery codes, mark the
 * session as checked, and audit it, in one transaction. Returns the codes,
 * the only time they exist in plain text.
 */
export async function storeFactor(
	db: Kysely<Database>,
	input: NewFactor,
): Promise<string[]> {
	return db.transaction().execute(async (trx) => {
		const now = new Date().toISOString();
		const factor = await trx
			.insertInto("user_second_factors")
			.values({
				user_id: input.userId,
				kind: input.kind,
				secret: input.secret,
				label: input.label,
				last_step: input.lastStep,
				last_used_at: now,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const codes = await writeRecoveryCodes(trx, input.userId);
		await trx
			.updateTable("sessions")
			.set({ second_factor_at: now })
			.where("id", "=", input.sessionId)
			.execute();
		await recordAudit(trx, {
			actor: input.actor,
			target: input.userId,
			action: "auth.second_factor_enrolled",
			result: "ok",
			metadata: { ...input.metadata, kind: input.kind, factorId: factor.id },
		});
		return codes;
	});
}

/** Store a confirmed TOTP factor, sealed for this account (see `storeFactor`). */
export async function enrolTotp(
	db: Kysely<Database>,
	key: Buffer,
	input: EnrolTotpInput,
): Promise<string[]> {
	return storeFactor(db, {
		userId: input.userId,
		kind: "totp",
		secret: sealSecret(key, input.secret, storedContext(input.userId)),
		label: input.label,
		lastStep: input.step,
		sessionId: input.sessionId,
		actor: input.actor,
		metadata: input.metadata,
	});
}

/**
 * New recovery codes for an account that has a factor; the old ones stop
 * working at once. Returns null when the account has no factor.
 */
export async function replaceRecoveryCodes(
	db: Kysely<Database>,
	userId: string,
	actor: string,
	metadata: Record<string, unknown>,
): Promise<string[] | null> {
	return db.transaction().execute(async (trx) => {
		const factors = await trx
			.selectFrom("user_second_factors")
			.select("id")
			.where("user_id", "=", userId)
			.forUpdate()
			.execute();
		if (factors.length === 0) return null;
		const codes = await writeRecoveryCodes(trx, userId);
		await recordAudit(trx, {
			actor,
			target: userId,
			action: "auth.second_factor_recovery_codes_replaced",
			result: "ok",
			metadata,
		});
		return codes;
	});
}

export type SecondFactorCheck =
	| { ok: true; method: "totp" | "recovery_code" | "webauthn" }
	| { ok: false };

/**
 * Check a code against the account's TOTP factors, then its unused
 * recovery codes. A match is consumed in the same conditional update that
 * finds it, so parallel requests cannot use one code twice.
 */
export async function checkSecondFactor(
	db: Kysely<Database>,
	key: Buffer,
	userId: string,
	code: string,
	nowMs: number = Date.now(),
): Promise<SecondFactorCheck> {
	const typed = code.replace(/\s/g, "");
	const now = new Date(nowMs).toISOString();
	if (/^\d{6}$/.test(typed)) {
		const factors = await db
			.selectFrom("user_second_factors")
			.select(["id", "secret", "last_step"])
			.where("user_id", "=", userId)
			.where("kind", "=", "totp")
			.execute();
		for (const factor of factors) {
			const secret = openSecret(key, factor.secret, storedContext(userId));
			if (!secret) continue;
			const lastStep = factor.last_step === null ? null : Number(factor.last_step);
			const step = matchTotp(secret, typed, nowMs, lastStep);
			if (step === null) continue;
			const used = await db
				.updateTable("user_second_factors")
				.set({ last_step: step, last_used_at: now })
				.where("id", "=", factor.id)
				.where((eb) =>
					eb.or([eb("last_step", "is", null), eb("last_step", "<", String(step))]),
				)
				.executeTakeFirst();
			if (used.numUpdatedRows > 0n) return { ok: true, method: "totp" };
		}
		return { ok: false };
	}
	const used = await db
		.updateTable("user_recovery_codes")
		.set({ used_at: now })
		.where("user_id", "=", userId)
		.where("code_hash", "=", hashRecoveryCode(typed))
		.where("used_at", "is", null)
		.executeTakeFirst();
	return used.numUpdatedRows > 0n
		? { ok: true, method: "recovery_code" }
		: { ok: false };
}

/**
 * Whether a session must pass the second-factor check: it signed in with a
 * Dex local password (SPEC.md section 24.13). Course launches, and Dex's
 * other connectors such as Entra or Google, leave it to the provider.
 * Dex is the only non-course issuer (ADR 0031), so the subject decides.
 */
export function secondFactorApplies(row: {
	oidc_issuer: string;
	oidc_subject: string;
	method: string;
}): boolean {
	return (
		row.method !== "lti" &&
		!isCourseIssuer(row.oidc_issuer) &&
		dexLocalUserId(row.oidc_subject) !== null
	);
}

/** Mark a session as having passed the second-factor check. */
export async function markSecondFactorPassed(
	db: Kysely<Database>,
	sessionId: string,
): Promise<void> {
	await db
		.updateTable("sessions")
		.set({ second_factor_at: new Date().toISOString() })
		.where("id", "=", sessionId)
		.execute();
}

/**
 * Remove every second factor and recovery code of an account, for someone
 * who lost theirs (SPEC.md section 24.13). Its sessions must enrol again
 * at their next request. `actor` is the audit actor, such as `user:<id>`
 * or `host:root`. Accepts the db or a transaction.
 */
export async function resetSecondFactor(
	db: Kysely<Database>,
	userId: string,
	actor: string,
): Promise<void> {
	if (!db.isTransaction) {
		await db.transaction().execute((trx) => resetSecondFactor(trx, userId, actor));
		return;
	}
	await db.deleteFrom("user_second_factors").where("user_id", "=", userId).execute();
	await db.deleteFrom("user_recovery_codes").where("user_id", "=", userId).execute();
	await db
		.updateTable("sessions")
		.set({ second_factor_at: null })
		.where("user_id", "=", userId)
		.execute();
	await recordAudit(db, {
		actor,
		target: userId,
		action: "auth.second_factor_reset",
		result: "ok",
		metadata: {},
	});
}
