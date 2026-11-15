import {
	allowedKeyPeriods,
	createApiKey,
	type KeyTarget,
	listApiKeys,
	listApiKeysForAdmin,
	renewApiKey,
	requireRole,
	requireUser,
} from "@portikus/auth";
import {
	type AdminApiKeyList,
	type ApiError,
	type ApiKey,
	type ApiKeyActionResult,
	type ApiKeyList,
	CreateApiKeyRequest,
	type CreatedApiKey,
	type PasskeyOptions,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { expireKeys, revokeKeys } from "../api-keys/actions.js";
import type { ServerDeps } from "../deps.js";
import { parseFieldsOr400, parseOr400, sendError, UuidParam } from "../http.js";
import type { SecondFactorThrottle } from "../second-factor-throttle.js";
import { requestMetadata } from "../sessions/start-session.js";
import { createStepUp } from "../sessions/step-up.js";

const AdminKeyQuery = z.object({ userId: z.string().uuid().optional() }).strict();

/**
 * Only an administrator or instructor in a signed-in browser manages keys
 * (SPEC.md section 24.13). The routes are on the catalog's never list, so the
 * gate already refuses a key; the check here holds even if that list changed.
 */
async function staffSession(request: FastifyRequest, reply: FastifyReply) {
	if (request.apiKey) {
		const body: ApiError = {
			code: "NOT_AVAILABLE_TO_API_KEYS",
			message: "API keys are managed in a signed-in browser.",
		};
		return reply.status(403).send(body);
	}
	if (request.user?.role !== "administrator" && request.user?.role !== "instructor") {
		return sendError(
			reply,
			403,
			"FORBIDDEN",
			"Only administrators and instructors have API keys.",
		);
	}
}

/**
 * API keys (SPEC.md sections 24.8 and 24.13): an owner makes, renews and
 * revokes their own; an administrator expires or revokes one key, one
 * person's keys, or every key. Renewal is open to expired keys and never to
 * revoked ones.
 */
export function registerApiKeyRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
	throttle: SecondFactorThrottle,
): void {
	const { db } = deps;
	const stepUp = createStepUp(deps, throttle, {
		flow: "api_key",
		enrolMessage: "Set up two-step sign-in before you make an API key.",
	});
	const staffOnly = { preHandler: staffSession };
	const adminOnly = { preHandler: requireRole("administrator") };

	async function accountOf(userId: string) {
		return db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.where("id", "=", userId)
			.executeTakeFirstOrThrow();
	}

	app.get("/me/api-keys", staffOnly, async (request) => {
		const user = requireUser(request);
		const body: ApiKeyList = {
			keys: await listApiKeys(db, user.id),
			periods: [...allowedKeyPeriods(await accountOf(user.id))],
		};
		return body;
	});

	// A passkey challenge for the create dialog of a Dex local-password account.
	app.post("/me/api-keys/passkey/start", staffOnly, async (request, reply) => {
		const user = requireUser(request);
		if ((await stepUp.owed(user.id)) !== "verify") {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"Making a key needs no passkey.",
			);
		}
		const options = await stepUp.startPasskey(request, user.id);
		if (options === null) {
			return sendError(
				reply,
				400,
				"NO_PASSKEY",
				"This account has no passkey. Use your authenticator app or a recovery code.",
			);
		}
		const body: PasskeyOptions = options;
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/api-keys", staffOnly, async (request, reply) => {
		const user = requireUser(request);
		// The body may carry a code, so a refusal names only the fields.
		const input = parseFieldsOr400(CreateApiKeyRequest, request.body ?? {}, reply);
		if (!input) return reply;
		const { code, credential, ...fields } = input;
		// A Dex local-password account proves its second factor again here.
		const checked = await stepUp.pass(request, reply, user.id, { code, credential });
		if (checked === "refused") return reply;
		const made = await db.transaction().execute(async (trx) => {
			const result = await createApiKey(trx, user.id, fields);
			if (!result.ok) return result;
			await recordAudit(trx, {
				actor: `user:${user.id}`,
				target: user.id,
				action: "api_key.created",
				result: "ok",
				metadata: {
					keyId: result.key.id,
					name: result.key.name,
					scope: result.key.scope,
					periodDays: result.key.periodDays,
					...requestMetadata(request),
				},
			});
			return result;
		});
		if (!made.ok) {
			return made.reason === "not_staff"
				? sendError(
						reply,
						403,
						"FORBIDDEN",
						"Only administrators and instructors have API keys.",
					)
				: sendError(
						reply,
						400,
						"VALIDATION_FAILED",
						"Your account cannot choose that period.",
					);
		}
		const body: CreatedApiKey = { key: made.key, secret: made.secret };
		return reply.status(201).header("cache-control", "no-store").send(body);
	});

	/** Renew one of the caller's keys; null when the reply is already sent. */
	async function renew(
		request: FastifyRequest,
		reply: FastifyReply,
		newSecret: boolean,
	): Promise<{ key: ApiKey; secret: string | null } | null> {
		const user = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return null;
		const renewed = await db.transaction().execute(async (trx) => {
			const result = await renewApiKey(trx, user.id, params.id, { newSecret });
			if (!result.ok) return result;
			await recordAudit(trx, {
				actor: `user:${user.id}`,
				target: user.id,
				action: newSecret ? "api_key.rotated" : "api_key.renewed",
				result: "ok",
				metadata: {
					keyId: result.key.id,
					name: result.key.name,
					...requestMetadata(request),
				},
			});
			return result;
		});
		if (renewed.ok) return renewed;
		if (renewed.reason === "revoked") {
			sendError(reply, 409, "API_KEY_REVOKED", "A revoked key can never be renewed.");
		} else {
			sendError(reply, 404, "NOT_FOUND", "Key not found");
		}
		return null;
	}

	app.post("/me/api-keys/:id/renew", staffOnly, async (request, reply) => {
		const renewed = await renew(request, reply, false);
		if (!renewed) return reply;
		const body: ApiKey = renewed.key;
		return body;
	});

	app.post("/me/api-keys/:id/rotate", staffOnly, async (request, reply) => {
		const renewed = await renew(request, reply, true);
		if (!renewed) return reply;
		if (renewed.secret === null)
			throw new Error("a rotated key came back with no secret");
		const body: CreatedApiKey = { key: renewed.key, secret: renewed.secret };
		return reply.header("cache-control", "no-store").send(body);
	});

	/** Whether a key with this id exists, for one owner or for anyone. */
	async function keyExists(keyId: string, ownerId?: string): Promise<boolean> {
		let query = db.selectFrom("api_keys").select("id").where("id", "=", keyId);
		if (ownerId !== undefined) query = query.where("user_id", "=", ownerId);
		return (await query.executeTakeFirst()) !== undefined;
	}

	/** Run an expire or revoke on `target`; a one-key target that names no key is a 404. */
	async function act(
		request: FastifyRequest,
		reply: FastifyReply,
		run: typeof revokeKeys,
		target: KeyTarget,
	) {
		const actor = requireUser(request);
		const changed = await db
			.transaction()
			.execute((trx) => run(trx, target, actor.id, requestMetadata(request)));
		if (
			changed.length === 0 &&
			"keyId" in target &&
			!(await keyExists(target.keyId, target.ownerId))
		) {
			return sendError(reply, 404, "NOT_FOUND", "Key not found");
		}
		const body: ApiKeyActionResult = { affected: changed.length };
		return body;
	}

	app.post("/me/api-keys/:id/revoke", staffOnly, async (request, reply) => {
		const user = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return reply;
		return act(request, reply, revokeKeys, { keyId: params.id, ownerId: user.id });
	});

	app.get("/admin/api-keys", adminOnly, async (request, reply) => {
		const query = parseOr400(AdminKeyQuery, request.query ?? {}, reply);
		if (!query) return reply;
		const filter = query.userId === undefined ? {} : { userId: query.userId };
		const body: AdminApiKeyList = { keys: await listApiKeysForAdmin(db, filter) };
		return body;
	});

	for (const [verb, run] of [
		["expire", expireKeys],
		["revoke", revokeKeys],
	] as const) {
		app.post(`/admin/api-keys/:id/${verb}`, adminOnly, async (request, reply) => {
			const params = parseOr400(UuidParam, request.params, reply);
			if (!params) return reply;
			return act(request, reply, run, { keyId: params.id });
		});
		app.post(`/admin/users/:id/api-keys/${verb}`, adminOnly, async (request, reply) => {
			const params = parseOr400(UuidParam, request.params, reply);
			if (!params) return reply;
			return act(request, reply, run, { userId: params.id });
		});
		app.post(`/admin/api-keys/${verb}-all`, adminOnly, async (request, reply) =>
			act(request, reply, run, { all: true }),
		);
	}
}
