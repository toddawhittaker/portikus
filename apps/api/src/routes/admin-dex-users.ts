import {
	type DexApi,
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
	UpdateDexUserRequest,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	createAdminSender,
	sendAdminSendFailure,
} from "../account-email/admin-send.js";
import { accountEmailEnabled } from "../account-email/send.js";
import { createDexAccount, DexCallFailed, viaDex } from "../admin/dex-accounts.js";
import { editDexUser, findDexPasswords } from "../admin/dex-user-edit.js";
import { refuseInstallAdminChange } from "../admin/install-admin.js";
import { notifyCredentialReset } from "../admin/reset-notice.js";
import { disableUser, loadAdminUser, sendDisableRefusal } from "../admin/users.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { endSessions } from "../sessions/end-sessions.js";
import { requestMetadata } from "../sessions/start-session.js";

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
	const { db } = deps;
	const sender = createAdminSender(deps);
	const notSent = sendAdminSendFailure;

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
	 * The Dex password behind a Portikus account: `email` is the one that
	 * matches the account, and `emails` lists every one under its user ID.
	 */
	async function findDexPassword(dex: DexApi, id: string) {
		const found = await findDexPasswords(db, dex, id);
		if (found.found === "no_account") return { found: "no_account" } as const;
		if (found.found === "not_local" || !found.current) {
			return { found: "not_local" } as const;
		}
		return {
			found: "yes",
			email: found.current.email,
			emails: found.mine.map((p) => p.email),
		} as const;
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
		const refused = await refuseInstallAdminChange(db, {
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
		const { sendLink, ...fields } = body.data;
		if (sendLink && !(await accountEmailEnabled(db))) return notSent(reply, "disabled");
		let created: Awaited<ReturnType<typeof createDexAccount>>;
		try {
			created = await createDexAccount(
				{ db, dex, log: request.log },
				{ ...fields, actorId: actor.id, metadata: requestMetadata(request) },
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
		// A failed send still shows the password, so the person is not left without one.
		const emailed =
			sendLink === true &&
			(await sender.setPasswordLink({
				userId: id,
				actorId: actor.id,
				purpose: "invite",
				to: fields.email,
			})) === "sent";
		const user = await loadAdminUser(deps, id);
		if (!user) throw new Error("the new account vanished");
		const out: CreateDexUserResponse = {
			user,
			password: emailed ? null : password,
			emailed,
		};
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
		const refused = await refuseInstallAdminChange(db, {
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
					for (const email of found.emails) await viaDex(dex.deletePassword(email));
				},
			});
			if (!result.ok) return sendDisableRefusal(reply, result.reason);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		return loadAdminUser(deps, id);
	});

	// Email a reset link to the address Dex holds (SPEC.md section 5.3).
	app.post(
		"/admin/dex-users/:id/send-reset-link",
		adminOnly,
		async (request, reply) => {
			const target = await resetTarget(request, reply, {
				self: "You cannot send yourself a reset link here.",
				action: "dex_user.reset_link_sent",
			});
			if (!target) return reply;
			const { actor, dex, id } = target;
			let found: Awaited<ReturnType<typeof findDexPassword>>;
			try {
				found = await findDexPassword(dex, id);
			} catch (err) {
				return dexUnavailable(request, reply, err);
			}
			if (found.found === "no_account") {
				return sendError(reply, 404, "NOT_FOUND", "User not found");
			}
			if (found.found === "not_local") return notLocal(reply);
			if (!(await accountEmailEnabled(db))) return notSent(reply, "disabled");
			const result = await sender.setPasswordLink({
				userId: id,
				actorId: actor.id,
				purpose: "reset",
				to: found.email,
			});
			if (result !== "sent") return notSent(reply, result);
			return reply.status(204).send();
		},
	);

	// A new email or username, keeping the account and workspace (SPEC.md section 5.1).
	app.patch("/admin/dex-users/:id", adminOnly, async (request, reply) => {
		const target = await resetTarget(request, reply, {
			self: "You cannot change your own email or username here.",
			action: "dex_user.updated",
		});
		if (!target) return reply;
		const { actor, dex, id } = target;
		const body = parseOr400(UpdateDexUserRequest, request.body ?? {}, reply);
		if (!body) return reply;
		let edited: Awaited<ReturnType<typeof editDexUser>>;
		try {
			edited = await editDexUser(
				{ db, dex, sender, publicUrl: deps.config.PUBLIC_URL },
				{ id, actorId: actor.id, body, metadata: requestMetadata(request) },
			);
		} catch (err) {
			return dexUnavailable(request, reply, err);
		}
		if (edited === "no_account")
			return sendError(reply, 404, "NOT_FOUND", "User not found");
		if (edited === "not_local") return notLocal(reply);
		if (edited === "exists") {
			return sendError(
				reply,
				409,
				"DEX_USER_EXISTS",
				"A Dex user with this email already exists.",
			);
		}
		const user = await loadAdminUser(deps, id);
		if (!user) throw new Error("the edited account vanished");
		const out: CreateDexUserResponse = { user, ...edited };
		return out;
	});
}
