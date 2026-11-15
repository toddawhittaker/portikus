import { randomBytes } from "node:crypto";
import {
	type AdminApiKey,
	API_KEY_PERIOD_DEFAULT,
	API_KEY_PERIODS_LOCAL,
	API_KEY_PREFIX,
	type ApiKey,
	type ApiKeyPeriod,
	type ApiKeyScope,
	type ApiKeyState,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import {
	type Expression,
	type ExpressionBuilder,
	type Kysely,
	type Selectable,
	type SqlBool,
	sql,
} from "kysely";
import { sha256Hex } from "./hash.js";
import { accountNeedsSecondFactor } from "./second-factor.js";
import type { AuthUser, Role } from "./types.js";

/**
 * API keys (SPEC.md sections 24.8 and 24.13). Only a key's SHA-256 is
 * stored. A secret leaves this module once, from `createApiKey` or from a
 * renewal with a new secret, and is never logged.
 */

/** Random bytes after the prefix. */
const SECRET_BYTES = 32;
/** Characters of the random part shown with the prefix, to tell keys apart. */
const DISPLAY_CHARS = 4;
const DAY_MS = 24 * 3600 * 1000;

export interface ApiKeyIdentity {
	id: string;
	scope: ApiKeyScope;
}

/** SHA-256 of a presented key, the value stored and looked up. */
export function hashApiKey(secret: string): string {
	return sha256Hex(secret);
}

/** Whether an `Authorization` value names an API key, and the key if so. */
export function bearerApiKey(header: string | undefined): string | null {
	const match = /^Bearer +(\S+)$/i.exec(header ?? "");
	const token = match?.[1];
	return token?.startsWith(API_KEY_PREFIX) ? token : null;
}

function generateSecret(): { secret: string; hash: string; prefix: string } {
	const random = randomBytes(SECRET_BYTES).toString("base64url");
	const secret = API_KEY_PREFIX + random;
	return {
		secret,
		hash: hashApiKey(secret),
		prefix: API_KEY_PREFIX + random.slice(0, DISPLAY_CHARS),
	};
}

/** The periods an account may choose: Dex local accounts any, the rest 30 days only. */
export function allowedKeyPeriods(account: {
	oidc_issuer: string;
	oidc_subject: string;
}): readonly ApiKeyPeriod[] {
	return accountNeedsSecondFactor(account)
		? API_KEY_PERIODS_LOCAL
		: [API_KEY_PERIOD_DEFAULT];
}

type KeyRow = Selectable<Database["api_keys"]>;

function stateOf(row: KeyRow, now: Date): ApiKeyState {
	if (row.revoked_at !== null) return "revoked";
	if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) {
		return "expired";
	}
	return "active";
}

function iso(date: Date | null): string | null {
	return date === null ? null : date.toISOString();
}

function toApiKey(row: KeyRow, now: Date): ApiKey {
	return {
		id: row.id,
		name: row.name,
		prefix: row.display_prefix,
		scope: row.scope,
		periodDays: row.period_days as ApiKeyPeriod,
		state: stateOf(row, now),
		createdAt: row.created_at.toISOString(),
		expiresAt: iso(row.expires_at),
		lastUsedAt: iso(row.last_used_at),
		revokedAt: iso(row.revoked_at),
	};
}

function expiryFrom(now: Date, periodDays: number | null): Date | null {
	return periodDays === null ? null : new Date(now.getTime() + periodDays * DAY_MS);
}

/**
 * Resolve a presented key to its owner, as `loadSessionById` does for a
 * session. Null when the key is unknown, revoked or expired, when its owner
 * is disabled or no longer an administrator or instructor, or when the
 * owner is a course account a link has retired. The owner keeps no second
 * factor to pass: the key itself took one to create (SPEC.md section 24.13).
 */
export async function resolveApiKey(
	db: Kysely<Database>,
	secret: string,
	now: Date = new Date(),
): Promise<{ user: AuthUser; key: ApiKeyIdentity } | null> {
	const row = await db
		.selectFrom("api_keys")
		.innerJoin("users", "users.id", "api_keys.user_id")
		.leftJoin("settings", (join) => join.on("settings.id", "=", 1))
		.select([
			"api_keys.id as key_id",
			"api_keys.scope",
			"api_keys.expires_at",
			"users.id as user_id",
			"users.email",
			"users.display_name",
			"users.role",
			"users.must_change_password",
			"users.acceptable_use_version as accepted_use_version",
			"settings.acceptable_use_version as current_use_version",
		])
		.where("api_keys.token_hash", "=", hashApiKey(secret))
		.where("api_keys.revoked_at", "is", null)
		.where("users.disabled_at", "is", null)
		.where("users.role", "<>", "student")
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("account_links")
						.select("account_links.course_user_id")
						.whereRef("account_links.course_user_id", "=", "users.id"),
				),
			),
		)
		.executeTakeFirst();
	if (!row) return null;
	if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) {
		return null;
	}
	return {
		user: {
			id: row.user_id,
			email: row.email,
			displayName: row.display_name,
			role: row.role as Role,
			mustChangePassword: row.must_change_password,
			mustAcceptUse: row.accepted_use_version !== (row.current_use_version ?? 1),
			secondFactor: null,
			secondFactorApplies: false,
		},
		key: { id: row.key_id, scope: row.scope },
	};
}

/** Note that a key was just used, at most once a minute so a busy client costs one write. */
export async function touchApiKey(db: Kysely<Database>, keyId: string): Promise<void> {
	await db
		.updateTable("api_keys")
		.set({ last_used_at: sql<Date>`now()` })
		.where("id", "=", keyId)
		.where((eb) =>
			eb.or([
				eb("last_used_at", "is", null),
				eb("last_used_at", "<", sql<Date>`now() - interval '1 minute'`),
			]),
		)
		.execute();
}

export type CreateKeyRefusal = "not_staff" | "period_not_allowed";

export interface CreateKeyInput {
	name: string;
	scope: ApiKeyScope;
	periodDays: ApiKeyPeriod;
}

/**
 * Make a key for an administrator or instructor. A student, or a period
 * the account may not have, is refused (SPEC.md section 24.13). The
 * caller has already proved a second factor where one is owed.
 */
export async function createApiKey(
	db: Kysely<Database>,
	userId: string,
	input: CreateKeyInput,
	now: Date = new Date(),
): Promise<
	{ ok: true; key: ApiKey; secret: string } | { ok: false; reason: CreateKeyRefusal }
> {
	const owner = await db
		.selectFrom("users")
		.select(["role", "oidc_issuer", "oidc_subject"])
		.where("id", "=", userId)
		.where("disabled_at", "is", null)
		.executeTakeFirst();
	if (!owner || owner.role === "student") return { ok: false, reason: "not_staff" };
	if (!allowedKeyPeriods(owner).includes(input.periodDays)) {
		return { ok: false, reason: "period_not_allowed" };
	}
	const made = generateSecret();
	const row = await db
		.insertInto("api_keys")
		.values({
			user_id: userId,
			name: input.name,
			token_hash: made.hash,
			display_prefix: made.prefix,
			scope: input.scope,
			period_days: input.periodDays,
			created_at: now,
			expires_at: expiryFrom(now, input.periodDays),
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return { ok: true, key: toApiKey(row, now), secret: made.secret };
}

export type RenewRefusal = "not_found" | "revoked";

/**
 * Renew one of the owner's keys: restart its own period from now. An expired
 * key may be renewed whenever; a revoked one never (SPEC.md section 24.13).
 * With `newSecret` the key gets a fresh secret, for one that may have leaked.
 */
export async function renewApiKey(
	db: Kysely<Database>,
	userId: string,
	keyId: string,
	options: { newSecret: boolean },
	now: Date = new Date(),
): Promise<
	{ ok: true; key: ApiKey; secret: string | null } | { ok: false; reason: RenewRefusal }
> {
	const made = options.newSecret ? generateSecret() : null;
	const row = await db
		.updateTable("api_keys")
		.set({
			// A key with no period stays null: the sum is null.
			expires_at: sql<Date | null>`${now}::timestamptz + period_days * interval '1 day'`,
			// Reminded for a past expiry; the next one earns its own.
			expiry_reminded_for: null,
			...(made === null ? {} : { token_hash: made.hash, display_prefix: made.prefix }),
		})
		.where("id", "=", keyId)
		.where("user_id", "=", userId)
		.where("revoked_at", "is", null)
		.returningAll()
		.executeTakeFirst();
	if (row) {
		return { ok: true, key: toApiKey(row, now), secret: made?.secret ?? null };
	}
	const existing = await db
		.selectFrom("api_keys")
		.select("revoked_at")
		.where("id", "=", keyId)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	return { ok: false, reason: existing ? "revoked" : "not_found" };
}

/** Which keys an expire or revoke action reaches. */
export type KeyTarget =
	| { keyId: string; ownerId?: string }
	| { userId: string }
	| { all: true };

/** The keys an action changed, so the caller can audit and notify their owners. */
export interface ChangedKey {
	id: string;
	userId: string;
	name: string;
}

function targetFilter(target: KeyTarget) {
	return (eb: ExpressionBuilder<Database, "api_keys">) => {
		const parts: Expression<SqlBool>[] = [];
		if ("keyId" in target) {
			parts.push(eb("id", "=", target.keyId));
			if (target.ownerId !== undefined) parts.push(eb("user_id", "=", target.ownerId));
		} else if ("userId" in target) {
			parts.push(eb("user_id", "=", target.userId));
		}
		return eb.and(parts);
	};
}

/**
 * Revoke keys for good: a revoked key can never be renewed. `revokedBy` is
 * the person who did it, an administrator or the owner. Keys already revoked
 * are left alone, and an expired key can still be revoked.
 */
export async function revokeApiKeys(
	db: Kysely<Database>,
	target: KeyTarget,
	revokedBy: string,
	now: Date = new Date(),
): Promise<ChangedKey[]> {
	const rows = await db
		.updateTable("api_keys")
		.set({ revoked_at: now, revoked_by: revokedBy })
		.where("revoked_at", "is", null)
		.where(targetFilter(target))
		.returning(["id", "user_id", "name"])
		.execute();
	return rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name }));
}

/**
 * Expire keys now. An expired key stops working but its owner may renew it.
 * Revoked and already-expired keys are left alone.
 */
export async function expireApiKeys(
	db: Kysely<Database>,
	target: KeyTarget,
	now: Date = new Date(),
): Promise<ChangedKey[]> {
	const rows = await db
		.updateTable("api_keys")
		.set({ expires_at: now })
		.where("revoked_at", "is", null)
		.where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
		.where(targetFilter(target))
		.returning(["id", "user_id", "name"])
		.execute();
	return rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name }));
}

/** One person's keys, newest first. */
export async function listApiKeys(
	db: Kysely<Database>,
	userId: string,
	now: Date = new Date(),
): Promise<ApiKey[]> {
	const rows = await db
		.selectFrom("api_keys")
		.selectAll()
		.where("user_id", "=", userId)
		.orderBy("created_at", "desc")
		.execute();
	return rows.map((row) => toApiKey(row, now));
}

/** Every key on the site, or one person's, with whose each is. */
export async function listApiKeysForAdmin(
	db: Kysely<Database>,
	filter: { userId?: string } = {},
	now: Date = new Date(),
): Promise<AdminApiKey[]> {
	let query = db
		.selectFrom("api_keys")
		.innerJoin("users", "users.id", "api_keys.user_id")
		.selectAll("api_keys")
		.select(["users.display_name as owner_name", "users.role as owner_role"])
		.orderBy("api_keys.created_at", "desc");
	if (filter.userId !== undefined) {
		query = query.where("api_keys.user_id", "=", filter.userId);
	}
	const rows = await query.execute();
	return rows.map((row) => ({
		...toApiKey(row, now),
		owner: {
			id: row.user_id,
			displayName: row.owner_name,
			role: row.owner_role as Role,
		},
	}));
}
