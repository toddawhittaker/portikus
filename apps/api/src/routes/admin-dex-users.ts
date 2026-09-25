import {
	type DexApi,
	dexLocalUserId,
	generateDexPassword,
	hashDexPassword,
	precreateDexAccount,
	requireRole,
	requireUser,
} from "@portikus/auth";
import {
	CreateDexUserRequest,
	type CreateDexUserResponse,
	type DexPasswordResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../server.js";
import {
	disableUser,
	loadAdminUser,
	sendDisableRefusal,
	sendError,
	UuidParam,
} from "./admin.js";
import { audit, requestMetadata } from "./start-session.js";

/** Thrown inside a transaction to roll it back when Dex refuses the email. */
class DexEmailTaken extends Error {}

/** A failed Dex call, told apart from a database error. */
class DexCallFailed extends Error {
	constructor(readonly grpcCode: number | null) {
		super("dex call failed");
	}
}

/** Run one Dex call, turning its failure into DexCallFailed. */
async function viaDex<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		throw new DexCallFailed(typeof code === "number" ? code : null);
	}
}

/**
 * Add, reset the password of, and remove standalone Dex users (docs/EPIC-14.md
 * rulings 21, 22 and 24). The routes answer 404 unless the site runs Dex's
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

	/** Best effort: delete a Dex password whose account did not commit. */
	async function removeOrphan(request: FastifyRequest, dex: DexApi, email: string) {
		await dex.deletePassword(email).catch((err: unknown) => {
			const code = (err as { code?: unknown }).code;
			request.log.error(
				{ grpcCode: typeof code === "number" ? code : null },
				"dex password left without an account",
			);
		});
	}

	const notLocal = (reply: FastifyReply) =>
		sendError(reply, 400, "VALIDATION_FAILED", "This account has no Dex password.");

	const adminOnly = { preHandler: requireRole("administrator") };

	// POST /admin/dex-users -- a new Dex password and its pre-created account (ruling 21).
	app.post("/admin/dex-users", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return reply;
		const body = CreateDexUserRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const { email, username, role } = body.data;
		const dexUserId = crypto.randomUUID();
		const password = generateDexPassword();
		const hash = await hashDexPassword(password);
		let id: string;
		let dexCreated = false;
		try {
			// The account and the Dex password are made together, or neither is.
			id = await db.transaction().execute(async (trx) => {
				const newId = await precreateDexAccount(trx, config.OIDC_ISSUER_URL, {
					userId: dexUserId,
					email,
					username,
					// A Dex password has no display name: Dex sends the username.
					displayName: username,
					role,
				});
				await audit(trx, "dex_user.created", `user:${actor.id}`, newId, "ok", {
					role,
					...requestMetadata(request),
				});
				const created = await viaDex(
					dex.createPassword({ email, username, userId: dexUserId, hash }),
				);
				if (created === "already_exists") throw new DexEmailTaken();
				dexCreated = true;
				return newId;
			});
		} catch (err) {
			if (dexCreated) await removeOrphan(request, dex, email);
			if (err instanceof DexEmailTaken) {
				return sendError(
					reply,
					409,
					"DEX_USER_EXISTS",
					"A Dex user with this email already exists.",
				);
			}
			return dexUnavailable(request, reply, err);
		}
		const user = await loadAdminUser(deps, id);
		if (!user) throw new Error("the new account vanished");
		const out: CreateDexUserResponse = { user, password };
		return out;
	});

	// POST /admin/dex-users/:id/reset-password -- a new password; sessions end (ruling 22).
	app.post("/admin/dex-users/:id/reset-password", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return reply;
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
		// Resetting it would end the caller's own session before they saw the password.
		if (id === actor.id) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"You cannot reset your own password here.",
			);
		}
		const password = generateDexPassword();
		try {
			const found = await findDexPassword(dex, id);
			if (found.found === "no_account") {
				return sendError(reply, 404, "NOT_FOUND", "User not found");
			}
			if (found.found === "not_local") return notLocal(reply);
			const hash = await hashDexPassword(password);
			const updated = await db.transaction().execute(async (trx) => {
				const now = new Date().toISOString();
				await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
				await trx
					.updateTable("preview_sessions")
					.set({ revoked_at: now })
					.where("user_id", "=", id)
					.where("revoked_at", "is", null)
					.execute();
				await audit(trx, "dex_user.password_reset", `user:${actor.id}`, id, "ok", {
					...requestMetadata(request),
				});
				return viaDex(dex.updatePassword(found.email, hash));
			});
			if (updated === "not_found") return notLocal(reply);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		const out: DexPasswordResponse = { password };
		return out;
	});

	// POST /admin/dex-users/:id/remove -- delete the Dex password, disable the account (ruling 22).
	app.post("/admin/dex-users/:id/remove", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const dex = dexOr404(reply);
		if (!dex) return reply;
		const params = UuidParam.safeParse(request.params);
		if (!params.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const id = params.data.id;
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
				alsoInTransaction: async (trx) => {
					await audit(trx, "dex_user.removed", `user:${actor.id}`, id, "ok", {
						...requestMetadata(request),
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
