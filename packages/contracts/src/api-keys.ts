import { z } from "zod";
import { PasskeyCredential } from "./auth.js";

/**
 * API keys for administrators and instructors (SPEC.md sections 24.8 and
 * 24.13). A key's secret appears once, in the answer that creates it or
 * renews it with a new secret; every other answer carries only its prefix.
 */

/** Every key starts with this, so a leaked one is easy to recognise and scan for. */
export const API_KEY_PREFIX = "portikus_";

/** One ordered level: destructive includes write includes read. */
export const ApiKeyScope = z.enum(["read", "write", "destructive"]);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

/** Days a key lasts; null means it never expires. */
export const ApiKeyPeriod = z.union([
	z.literal(7),
	z.literal(30),
	z.literal(90),
	z.null(),
]);
export type ApiKeyPeriod = z.infer<typeof ApiKeyPeriod>;

/** Dex local-password accounts choose any of these. */
export const API_KEY_PERIODS_LOCAL: readonly ApiKeyPeriod[] = [7, 30, 90, null];
/** SSO and course-launch accounts get this one only. */
export const API_KEY_PERIOD_DEFAULT = 30;

/** Expired keys can be renewed; revoked keys never. */
export const ApiKeyState = z.enum(["active", "expired", "revoked"]);
export type ApiKeyState = z.infer<typeof ApiKeyState>;

/** One key as its owner sees it. */
export const ApiKey = z.object({
	id: z.string().uuid(),
	name: z.string(),
	/** The start of the key, enough to tell keys apart. */
	prefix: z.string(),
	scope: ApiKeyScope,
	periodDays: ApiKeyPeriod,
	state: ApiKeyState,
	createdAt: z.string().datetime(),
	/** Null means the key never expires. */
	expiresAt: z.string().datetime().nullable(),
	lastUsedAt: z.string().datetime().nullable(),
	revokedAt: z.string().datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** One key as an administrator sees it, with whose it is. */
export const AdminApiKey = ApiKey.extend({
	owner: z.object({
		id: z.string().uuid(),
		displayName: z.string(),
		role: z.enum(["administrator", "instructor", "student"]),
	}),
});
export type AdminApiKey = z.infer<typeof AdminApiKey>;

/** The answer that carries a secret: shown once and never again. */
export const CreatedApiKey = z.object({ key: ApiKey, secret: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

export const ApiKeyList = z.object({
	keys: z.array(ApiKey),
	/** The periods this account may choose, so the dialog offers only those. */
	periods: z.array(ApiKeyPeriod),
});
export type ApiKeyList = z.infer<typeof ApiKeyList>;

export const AdminApiKeyList = z.object({ keys: z.array(AdminApiKey) });
export type AdminApiKeyList = z.infer<typeof AdminApiKeyList>;

/** The second-factor proof a Dex local-password account sends with an action that issues a secret. */
const secondFactorProof = {
	code: z.string().trim().min(1).max(64).optional(),
	credential: PasskeyCredential.optional(),
};

/** A code or a passkey answer, never both. */
function oneProofOnly(body: { code?: string | undefined; credential?: unknown }) {
	return body.code === undefined || body.credential === undefined;
}
const ONE_PROOF_MESSAGE = { message: "Send a code or a passkey, not both." };

/**
 * `POST /me/api-keys`. A Dex local-password account also sends the code or
 * the passkey answer that proves its second factor; never both.
 */
export const CreateApiKeyRequest = z
	.object({
		name: z.string().trim().min(1).max(100),
		scope: ApiKeyScope.default("read"),
		periodDays: ApiKeyPeriod.default(API_KEY_PERIOD_DEFAULT),
		...secondFactorProof,
	})
	.strict()
	.refine(oneProofOnly, ONE_PROOF_MESSAGE);
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

/**
 * `POST /me/api-keys/:id/rotate`: a new secret is as sensitive as a new key, so
 * it takes the same proof as `POST /me/api-keys` (SPEC.md section 24.13).
 */
export const RotateApiKeyRequest = z
	.object(secondFactorProof)
	.strict()
	.refine(oneProofOnly, ONE_PROOF_MESSAGE);
export type RotateApiKeyRequest = z.infer<typeof RotateApiKeyRequest>;

/** How many keys an expire or revoke action changed. */
export const ApiKeyActionResult = z.object({
	affected: z.number().int().nonnegative(),
});
export type ApiKeyActionResult = z.infer<typeof ApiKeyActionResult>;
