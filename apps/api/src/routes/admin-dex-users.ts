import {
	type DexApi,
	dexLocalUserId,
	generateDexPassword,
	hashDexPassword,
	requireRole,
	requireUser,
	resetSecondFactor,
} from "@portikus/auth";
import {
	CreateDexUserRequest,
	type CreateDexUserResponse,
	type DexPasswordResponse,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createDexAccount, DexCallFailed, viaDex } from "../admin/dex-accounts.js";
import { refuseInstallAdminChange } from "../admin/install-admin.js";
import { notifyCredentialReset } from "../admin/reset-notice.js";
import { disableUser, loadAdminUser, sendDisableRefusal } from "../admin/users.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { requestMetadata } from "../sessions/start-session.js";

/** End every platform and preview session of an account. */
async function endSessions(trx: Kysely<Database>, id: string): Promise<void> {
	await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
	await trx
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.where("user_id", "=", id)
		.where("revoked_at", "is", null)
		.execute();
}

/**
 * Add, reset the password of, and remove standalone Dex users
 * (ADR 0028). The routes answer 404 unless the site runs Dex's
 * gRPC API. A generated password leaves Portikus only in one response body:
 * it is never stored, logged, or audited.
 */
export function registerAdminDexUserRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;

	/** The Dex client, or null after answering 404 when the site has none. */
	function dexOr404(reply: FastifyReply): DexApi | null {
		if (deps.dex) return deps.dex;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return null;
	}

	/** Answer 503 for a failed Dex call; anything else is not ours to hide. */
	function dexUnavailable(request: FastifyRequest, reply: FastifyReply, err: unknown) {
		if (!(err instanceof DexCallFailed)) throw err;
		// The gRPC status only: a request carries a hash, never logged.
		request.log.error({ grpcCode: err.grpcCode }, "dex call failed");
		sendError(reply, 503, "DEX_UNAVAILABLE", "Dex could not be reached. Try again.");
	}

	/**
	 * The Dex password behind a Portikus account, found by user ID so a
	 * changed email cannot point at someone else's password.
	 */
	async function findDexPassword(dex: DexApi, id: string) {
		const row = await db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row) return { found: "no_account" } as const;
		const userId =
			row.oidc_issuer === config.OIDC_ISSUER_URL
				? dexLocalUserId(row.oidc_subject)
				: null;
		if (userId === null) return { found: "not_local" } as const;
		const password = (await viaDex(dex.listPasswords())).find(
			(p) => p.userId === userId,
		);
		if (!password) return { found: "not_local" } as const;
		return { found: "yes", email: password.email } as const;
	}

	/**
	 * The account a credential reset is for, or null after answering: not
	 * the caller's own, and not the install administrator (SPEC.md 24.13).
	 */
	async function resetTarget(
		request: FastifyRequest,
		reply: FastifyReply,
		refusal: { self: string; action: string },
	) {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return null;
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return null;
		const id = params.id;
		if (id === actor.id) {
			sendError(reply, 400, "VALIDATION_FAILED", refusal.self);
			return null;
		}
		const refused = await refuseInstallAdminChange(db, config.OIDC_ISSUER_URL, {
			request,
			reply,
			actorId: actor.id,
			targetId: id,
			action: refusal.action,
		});
		if (refused) return null;
		return { actor, dex, id };
	}

	const notLocal = (reply: FastifyReply) =>
		sendError(reply, 400, "VALIDATION_FAILED", "This account has no Dex password.");

	const adminOnly = { preHandler: requireRole("administrator") };

	// A new Dex password and its pre-created account.
	app.post("/admin/dex-users", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return reply;
		const body = CreateDexUserRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		let created: Awaited<ReturnType<typeof createDexAccount>>;
		try {
			created = await createDexAccount(
				{ db, dex, issuer: config.OIDC_ISSUER_URL, log: request.log },
				{ ...body.data, actorId: actor.id, metadata: requestMetadata(request) },
			);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		if (created === "exists") {
			return sendError(
				reply,
				409,
				"DEX_USER_EXISTS",
				"A Dex user with this email already exists.",
			);
		}
		const { id, password } = created;
		const user = await loadAdminUser(deps, id);
		if (!user) throw new Error("the new account vanished");
		const out: CreateDexUserResponse = { user, password };
		return out;
	});

	// A new password; the user's sessions end.
	app.post("/admin/dex-users/:id/reset-password", adminOnly, async (request, reply) => {
		// Resetting it would end the caller's own session before they saw the password.
		const target = await resetTarget(request, reply, {
			self: "You cannot reset your own password here.",
			action: "dex_user.password_reset",
		});
		if (!target) return reply;
		const { actor, dex, id } = target;
		const password = generateDexPassword();
		try {
			const found = await findDexPassword(dex, id);
			if (found.found === "no_account") {
				return sendError(reply, 404, "NOT_FOUND", "User not found");
			}
			if (found.found === "not_local") return notLocal(reply);
			const hash = await hashDexPassword(password);
			const updated = await db.transaction().execute(async (trx) => {
				await endSessions(trx, id);
				await trx
					.updateTable("users")
					.set({ must_change_password: true })
					.where("id", "=", id)
					.execute();
				await recordAudit(trx, {
					actor: `user:${actor.id}`,
					target: id,
					action: "dex_user.password_reset",
					result: "ok",
					metadata: {
						...requestMetadata(request),
					},
				});
				await notifyCredentialReset(trx, id, "password");
				return viaDex(dex.updatePassword(found.email, hash));
			});
			if (updated === "not_found") return notLocal(reply);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		const out: DexPasswordResponse = { password };
		return out;
	});

	// Clear every second factor; the person enrols again at next sign-in.
	app.post(
		"/admin/dex-users/:id/reset-second-factor",
		adminOnly,
		async (request, reply) => {
			const target = await resetTarget(request, reply, {
				self: "You cannot reset your own two-factor sign-in here.",
				action: "auth.second_factor_reset",
			});
			if (!target) return reply;
			const { actor, dex, id } = target;
			try {
				const found = await findDexPassword(dex, id);
				if (found.found === "no_account") {
					return sendError(reply, 404, "NOT_FOUND", "User not found");
				}
				if (found.found === "not_local") return notLocal(reply);
			} catch (err) {
				return dexUnavailable(request, reply, err);
			}
			await db.transaction().execute(async (trx) => {
				await resetSecondFactor(trx, id, `user:${actor.id}`);
				await endSessions(trx, id);
				await notifyCredentialReset(trx, id, "second_factor");
			});
			return loadAdminUser(deps, id);
		},
	);

	// Delete the Dex password and disable the account.
	app.post("/admin/dex-users/:id/remove", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return reply;
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const id = params.id;
		const refused = await refuseInstallAdminChange(db, config.OIDC_ISSUER_URL, {
			request,
			reply,
			actorId: actor.id,
			targetId: id,
			action: "dex_user.removed",
		});
		if (refused) return reply;
		try {
			const found = await findDexPassword(dex, id);
			if (found.found === "no_account") {
				return sendError(reply, 404, "NOT_FOUND", "User not found");
			}
			if (found.found === "not_local") return notLocal(reply);
			// The workspace stays for an administrator to archive.
			const result = await disableUser(db, {
				actorId: actor.id,
				targetId: id,
				metadata: requestMetadata(request),
				alsoInTransaction: async (trx) => {
					await recordAudit(trx, {
						actor: `user:${actor.id}`,
						target: id,
						action: "dex_user.removed",
						result: "ok",
						metadata: {
							...requestMetadata(request),
						},
					});
					await viaDex(dex.deletePassword(found.email));
				},
			});
			if (!result.ok) return sendDisableRefusal(reply, result.reason);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		return loadAdminUser(deps, id);
	});
}
