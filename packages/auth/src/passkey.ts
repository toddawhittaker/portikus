import type { Database } from "@portikus/db";
import {
	type AuthenticationResponseJSON,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Kysely } from "kysely";
import { z } from "zod";

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

/**
 * Passkeys (WebAuthn) as a second factor for Dex local-password accounts
 * (SPEC.md section 24.13). The relying party is the site's public host, the
 * origin is checked exactly, and each challenge is used once. A passkey's
 * record is public data, so it is stored as plain JSON in the factor's
 * `secret` column, with its sign count in `last_step`.
 */

/** How long a ceremony may take between asking for options and answering. */
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;

export interface RelyingParty {
	/** The public host, without port: WebAuthn's RP ID. */
	id: string;
	/** The exact origin a browser must report. */
	origin: string;
	name: string;
}

export function relyingParty(publicUrl: string): RelyingParty {
	const url = new URL(publicUrl);
	return { id: url.hostname, origin: url.origin, name: "Portikus" };
}

const StoredPasskey = z.object({
	credentialId: z.string().min(1),
	publicKey: z.string().min(1),
	transports: z.array(z.string()).default([]),
});
export type StoredPasskey = z.infer<typeof StoredPasskey>;

/** The record of a passkey row, or null when it is not one. */
export function parsePasskey(secret: string): StoredPasskey | null {
	try {
		const parsed = StoredPasskey.safeParse(JSON.parse(secret));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Challenges handed out and not yet answered, keyed by session and
 * ceremony. `take` removes the entry, so a challenge is never accepted
 * twice, and an expired one is never accepted at all. In memory, like
 * the sign-in throttle: a restart only makes someone start again.
 */
export function createChallengeStore(ttlMs: number = PASSKEY_CHALLENGE_TTL_MS) {
	const entries = new Map<string, { challenge: string; expiresAt: number }>();
	return {
		put(key: string, challenge: string, nowMs: number = Date.now()): void {
			for (const [k, entry] of entries) {
				if (entry.expiresAt <= nowMs) entries.delete(k);
			}
			entries.set(key, { challenge, expiresAt: nowMs + ttlMs });
		},
		take(key: string, nowMs: number = Date.now()): string | null {
			const entry = entries.get(key);
			entries.delete(key);
			if (!entry || entry.expiresAt <= nowMs) return null;
			return entry.challenge;
		},
	};
}
export type ChallengeStore = ReturnType<typeof createChallengeStore>;

function descriptors(passkeys: StoredPasskey[]) {
	return passkeys.map((p) => ({ id: p.credentialId, transports: p.transports }));
}

/** Options for creating a passkey; the account's own passkeys are excluded so one device is not added twice. */
export function passkeyRegistrationOptions(
	rp: RelyingParty,
	user: { id: string; name: string; displayName: string },
	existing: StoredPasskey[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: rp.name,
		rpID: rp.id,
		userID: new TextEncoder().encode(user.id),
		userName: user.name,
		userDisplayName: user.displayName,
		timeout: PASSKEY_CHALLENGE_TTL_MS,
		attestationType: "none",
		excludeCredentials: descriptors(existing),
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "preferred",
		},
	});
}

/** The passkey a registration answer proves, with its first sign count, or null when it does not verify. */
export async function verifyPasskeyRegistration(
	rp: RelyingParty,
	response: RegistrationResponseJSON,
	expectedChallenge: string,
): Promise<{ passkey: StoredPasskey; counter: number } | null> {
	try {
		const result = await verifyRegistrationResponse({
			response,
			expectedChallenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserVerification: false,
		});
		if (!result.verified) return null;
		const { credential } = result.registrationInfo;
		return {
			passkey: {
				credentialId: credential.id,
				publicKey: Buffer.from(credential.publicKey).toString("base64url"),
				transports: credential.transports ?? [],
			},
			counter: credential.counter,
		};
	} catch {
		return null;
	}
}

/** Options for signing in with one of the account's passkeys. */
export function passkeyAuthenticationOptions(
	rp: RelyingParty,
	passkeys: StoredPasskey[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return generateAuthenticationOptions({
		rpID: rp.id,
		allowCredentials: descriptors(passkeys),
		timeout: PASSKEY_CHALLENGE_TTL_MS,
		userVerification: "preferred",
	});
}

/** The account's passkeys, with their rows' ids and sign counts. */
export async function listPasskeys(
	db: Kysely<Database>,
	userId: string,
): Promise<{ id: string; counter: number; passkey: StoredPasskey }[]> {
	const rows = await db
		.selectFrom("user_second_factors")
		.select(["id", "secret", "last_step"])
		.where("user_id", "=", userId)
		.where("kind", "=", "webauthn")
		.execute();
	return rows.flatMap((row) => {
		const passkey = parsePasskey(row.secret);
		return passkey
			? [{ id: row.id, counter: Number(row.last_step ?? 0), passkey }]
			: [];
	});
}

export type PasskeyCheck =
	| { ok: true; factorId: string }
	| { ok: false; reason: "unknown" | "invalid" | "cloned" };

/**
 * Check a sign-in answer against the account's passkeys. A sign count that
 * does not go up, when the authenticator keeps one, means a copied key and
 * is refused. The new count is stored by a conditional update, so two
 * parallel answers cannot both pass with the same count.
 */
export async function checkPasskey(
	db: Kysely<Database>,
	rp: RelyingParty,
	userId: string,
	response: AuthenticationResponseJSON,
	expectedChallenge: string,
): Promise<PasskeyCheck> {
	const match = (await listPasskeys(db, userId)).find(
		(p) => p.passkey.credentialId === response.id,
	);
	if (!match) return { ok: false, reason: "unknown" };
	let newCounter: number;
	try {
		const result = await verifyAuthenticationResponse({
			response,
			expectedChallenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserVerification: false,
			credential: {
				id: match.passkey.credentialId,
				publicKey: Buffer.from(match.passkey.publicKey, "base64url"),
				counter: match.counter,
				transports: match.passkey.transports,
			},
		});
		if (!result.verified) return { ok: false, reason: "invalid" };
		newCounter = result.authenticationInfo.newCounter;
	} catch (failure) {
		// The library throws this one message for a count that did not go up.
		const cloned = failure instanceof Error && /counter value/i.test(failure.message);
		return { ok: false, reason: cloned ? "cloned" : "invalid" };
	}
	// Synced passkeys always report 0; there is no count to compare then.
	const used = await db
		.updateTable("user_second_factors")
		.set({ last_step: newCounter, last_used_at: new Date().toISOString() })
		.where("id", "=", match.id)
		.where((eb) =>
			newCounter === 0
				? eb("last_step", "=", "0")
				: eb.or([
						eb("last_step", "is", null),
						eb("last_step", "<", String(newCounter)),
					]),
		)
		.executeTakeFirst();
	if (used.numUpdatedRows === 0n) return { ok: false, reason: "cloned" };
	return { ok: true, factorId: match.id };
}
