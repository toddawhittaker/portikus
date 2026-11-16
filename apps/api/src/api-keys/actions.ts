import {
	type ChangedKey,
	expireApiKeys,
	type KeyTarget,
	revokeApiKeys,
} from "@portikus/auth";
import { type Database, recordAudit, recordNotification } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Expire or revoke keys with one audit row per key, and tell each owner when
 * someone else did it (SPEC.md sections 24.11 and 24.13). Run inside the
 * caller's transaction so the change and its rows commit together.
 */

type KeyAction = "expired" | "revoked";

const NOTICE: Record<KeyAction, { title: string; body: (names: string) => string }> = {
	expired: {
		title: "An administrator expired your API key",
		body: (names) =>
			`An administrator expired ${names}. It stops working until you sign in and renew it.`,
	},
	revoked: {
		title: "An administrator revoked your API key",
		body: (names) =>
			`An administrator revoked ${names}. It cannot be renewed; make a new key if you still need one.`,
	},
};

async function auditAndNotify(
	trx: Kysely<Database>,
	changed: ChangedKey[],
	action: KeyAction,
	actorId: string,
	metadata: Record<string, unknown>,
	actor = `user:${actorId}`,
): Promise<void> {
	const byOwner = new Map<string, ChangedKey[]>();
	for (const key of changed) {
		await recordAudit(trx, {
			actor,
			target: key.userId,
			action: action === "expired" ? "api_key.expired" : "api_key.revoked",
			result: "ok",
			metadata: { ...metadata, keyId: key.id, name: key.name },
		});
		if (key.userId !== actorId) {
			byOwner.set(key.userId, [...(byOwner.get(key.userId) ?? []), key]);
		}
	}
	// One notice per owner, however many of their keys one action reached.
	for (const [ownerId, keys] of byOwner) {
		const names =
			keys.length === 1
				? `your API key "${keys[0]?.name}"`
				: `${keys.length} of your API keys`;
		await recordNotification(trx, ownerId, {
			tone: "warning",
			title: NOTICE[action].title,
			body: NOTICE[action].body(names),
		});
	}
}

/** Revoke the target's keys for good, audited, notifying owners other than the actor. */
export async function revokeKeys(
	trx: Kysely<Database>,
	target: KeyTarget,
	actorId: string,
	metadata: Record<string, unknown>,
): Promise<ChangedKey[]> {
	const changed = await revokeApiKeys(trx, target, actorId);
	await auditAndNotify(trx, changed, "revoked", actorId, metadata);
	return changed;
}

/**
 * Revoke a person's keys because the identity provider or the course system
 * left them a student at sign-in: no person made the change, so the audit
 * actor is `identity-provider`, as on the role change itself (SPEC.md
 * section 24.11), and no one else is notified.
 */
export async function revokeKeysAtSignIn(
	trx: Kysely<Database>,
	userId: string,
	metadata: Record<string, unknown>,
): Promise<ChangedKey[]> {
	const changed = await revokeApiKeys(trx, { userId }, userId);
	await auditAndNotify(trx, changed, "revoked", userId, metadata, "identity-provider");
	return changed;
}

/** Expire the target's keys now, audited, notifying owners other than the actor. */
export async function expireKeys(
	trx: Kysely<Database>,
	target: KeyTarget,
	actorId: string,
	metadata: Record<string, unknown>,
): Promise<ChangedKey[]> {
	const changed = await expireApiKeys(trx, target);
	await auditAndNotify(trx, changed, "expired", actorId, metadata);
	return changed;
}
