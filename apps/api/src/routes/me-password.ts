import {
	dexLocalUserId,
	hashDexPassword,
	hashSessionToken,
	requireUser,
} from "@portikus/auth";
import { ChangePasswordRequest } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../server.js";
import { createPasswordChangeThrottle } from "../signin-throttle.js";
import { sendError } from "./admin.js";
import { audit, requestMetadata } from "./start-session.js";

/** Thrown inside the transaction when Dex no longer holds the password. */
class PasswordGone extends Error {}

/**
 * Settings, Password: change a Dex local password (docs/EPIC-14-2.md
 * ruling 16). The only route an account with the flag may use besides
 * `/auth/*` (ruling 18). No password or hash is ever logged or audited.
 */
export function registerMePasswordRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const throttle = createPasswordChangeThrottle();

	function notLocal(reply: FastifyReply) {
		sendError(reply, 400, "NOT_LOCAL_PASSWORD", "This account has no Dex password.");
		return reply;
	}

	function dexUnavailable(request: FastifyRequest, reply: FastifyReply, err: unknown) {
		const code = (err as { code?: unknown }).code;
		if (typeof code !== "number") throw err;
		// The gRPC status only: the request carried a password.
		request.log.error({ grpcCode: code }, "dex call failed");
		sendError(reply, 503, "DEX_UNAVAILABLE", "Dex could not be reached. Try again.");
		return reply;
	}

	app.post("/me/password", async (request, reply) => {
		const user = requireUser(request);
		const dex = deps.dex;
		if (!dex) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const body = ChangePasswordRequest.safeParse(request.body ?? {});
		if (!body.success) {
			// Zod's messages name the rule, never the value.
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				body.error.issues[0]?.message ?? "Invalid request",
			);
		}
		const { currentPassword, newPassword } = body.data;
		if (newPassword === currentPassword) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"Choose a password different from the current one.",
			);
		}

		const row = await db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		const dexUserId =
			row.oidc_issuer === config.OIDC_ISSUER_URL
				? dexLocalUserId(row.oidc_subject)
				: null;
		if (dexUserId === null) return notLocal(reply);

		const decision = throttle.check(request.ip);
		if (!decision.allowed) {
			if (decision.audit) {
				await audit(db, "auth.throttled", `user:${user.id}`, user.id, "denied", {
					ip: request.ip,
					scope: "password-change",
				});
			}
			return sendError(
				reply,
				429,
				"RATE_LIMITED",
				"Too many wrong passwords. Please wait a few minutes and try again.",
			);
		}

		const actor = `user:${user.id}`;
		const currentSession = hashSessionToken(request.sessionToken as string);
		try {
			// Found by user ID, so a changed email cannot point at someone else's password.
			const password = (await dex.listPasswords()).find((p) => p.userId === dexUserId);
			if (!password) return notLocal(reply);
			const verified = await dex.verifyPassword(password.email, currentPassword);
			if (verified === "not_found") return notLocal(reply);
			if (verified === "wrong") {
				throttle.fail(request.ip);
				await audit(db, "user.password_changed", actor, user.id, "failed", {
					...requestMetadata(request),
				});
				return sendError(
					reply,
					403,
					"WRONG_PASSWORD",
					"The current password is not right.",
				);
			}
			const hash = await hashDexPassword(newPassword);
			await db.transaction().execute(async (trx) => {
				const now = new Date().toISOString();
				await trx
					.updateTable("users")
					.set({ must_change_password: false, updated_at: now })
					.where("id", "=", user.id)
					.execute();
				await trx
					.deleteFrom("sessions")
					.where("user_id", "=", user.id)
					.where("id", "<>", currentSession)
					.execute();
				await trx
					.updateTable("preview_sessions")
					.set({ revoked_at: now })
					.where("user_id", "=", user.id)
					.where("session_id", "<>", currentSession)
					.where("revoked_at", "is", null)
					.execute();
				await audit(trx, "user.password_changed", actor, user.id, "ok", {
					...requestMetadata(request),
				});
				// Last, so a failure rolls the rest back.
				const updated = await dex.updatePassword(password.email, hash);
				if (updated === "not_found") throw new PasswordGone();
			});
		} catch (err) {
			if (err instanceof PasswordGone) return notLocal(reply);
			return dexUnavailable(request, reply, err);
		}
		return reply.status(204).send();
	});
}
