import {
	BREACHED_PASSWORD_MESSAGE,
	DEX_ACCOUNT_ISSUER,
	type DexApi,
	dexLocalSubject,
	hashDexPassword,
	isBreachedPassword,
	LOCAL_ADMIN_USER_ID,
} from "@portikus/auth";
import { PasswordResetComplete, PasswordResetRequest } from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resetConfirmationMessage, resetMessage } from "../account-email/messages.js";
import { type AccountEmailDeps, sendAccountEmail } from "../account-email/send.js";
import {
	type AccountEmailPurpose,
	consumeAccountEmailToken,
	issueAccountEmailToken,
	revokeAccountEmailTokens,
} from "../account-email/tokens.js";
import { DexCallFailed, viaDex } from "../admin/dex-accounts.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { addressKey } from "../rate-limit.js";
import { endSessions } from "../sessions/end-sessions.js";
import { requestMetadata } from "../sessions/start-session.js";
import { accountKey } from "../signin-throttle.js";
import { createStoredCounter } from "../stored-counter.js";

const HOUR_MS = 60 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;

/** The audit action of a completed emailed reset; passwordStamp ends known-device cookies on it. */
const RESET_DONE_ACTION = "user.password_reset_by_email";
const REQUESTED_ACTION = "user.password_reset_requested";

/** Thrown inside the transaction to roll it back; the caller answers as for a bad link. */
class NoPassword extends Error {}

/** A login the reset form can match: ASCII only, so look-alike letters never match. */
function loginKey(login: string): string | null {
	const key = accountKey(login);
	return key.length > 0 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

/**
 * Forgotten password by email (SPEC.md sections 5.3 and 24.13). Neither
 * route needs a session; the auth plugin checks CSRF on both. Tokens are
 * never logged or audited: audit rows carry only the token row id.
 */
export function registerPasswordResetRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config, logger } = deps;
	const counter = (scope: string, limit: number, windowMs: number) =>
		createStoredCounter({ db, logger, scope, limit, windowMs });
	const perAddress = counter("reset-request", 5, HOUR_MS);
	const perAccount = counter("reset-account", 3, HOUR_MS);
	const siteWide = counter("reset-site", 100, HOUR_MS);
	const badTokens = counter("reset-token", 20, TEN_MINUTES_MS);

	const mail: AccountEmailDeps = {
		db,
		notifyFile: config.NOTIFY_FILE,
		...(config.OUTBOUND_PROXY_URL ? { proxyUrl: config.OUTBOUND_PROXY_URL } : {}),
		...(config.MAIL_CAPTURE_FILE ? { captureFile: config.MAIL_CAPTURE_FILE } : {}),
	};

	// Detached work still running; shutdown waits for it so no query outlives the pool.
	const pending = new Set<Promise<void>>();
	function detach(work: () => Promise<void>): void {
		const task = work()
			.catch((err: unknown) => {
				logger.error({ err }, "password reset email task failed");
			})
			.finally(() => pending.delete(task));
		pending.add(task);
	}
	app.addHook("onClose", async () => {
		await Promise.all([...pending]);
	});

	async function auditThrottled(request: FastifyRequest, scope: string): Promise<void> {
		await recordAudit(db, {
			actor: "unknown",
			target: "unknown",
			action: "auth.throttled",
			result: "denied",
			metadata: { ip: request.ip, scope },
		});
	}

	/** The Dex password and Portikus account for a login, or null when there is none to mail. */
	async function findAccount(dex: DexApi, key: string) {
		const password = (await viaDex(dex.listPasswords())).find(
			(p) => p.email.toLowerCase() === key,
		);
		if (!password) return null;
		const user = await db
			.selectFrom("users")
			.select("id")
			.where("oidc_issuer", "=", DEX_ACCOUNT_ISSUER)
			.where("oidc_subject", "=", dexLocalSubject(password.userId))
			.where("disabled_at", "is", null)
			.executeTakeFirst();
		if (!user) return null;
		return { id: user.id, dexUserId: password.userId, email: password.email };
	}

	async function sendReset(
		dex: DexApi,
		login: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		const key = loginKey(login);
		if (key === null) return;
		const site = await siteWide.attempt("site");
		if (!site.allowed) {
			if (site.audit) logger.warn("site-wide password reset limit reached");
			return;
		}
		const account = await perAccount.attempt(key);
		if (!account.allowed) return;
		const found = await findAccount(dex, key);
		if (!found) return;
		if (found.dexUserId === LOCAL_ADMIN_USER_ID) {
			// The install administrator recovers with portikus reset-admin (SPEC.md 24.13).
			await recordAudit(db, {
				actor: "unknown",
				target: found.id,
				action: REQUESTED_ACTION,
				result: "denied",
				metadata: { reason: "install_administrator", ...metadata },
			});
			return;
		}
		const issued = await issueAccountEmailToken(db, {
			userId: found.id,
			purpose: "reset",
			createdBy: null,
		});
		// Only to the address Dex stores for this account, never one the request typed.
		const sent = await sendAccountEmail(
			mail,
			found.email,
			resetMessage(config.PUBLIC_URL, issued.token),
		);
		await recordAudit(db, {
			actor: "unknown",
			target: found.id,
			action: REQUESTED_ACTION,
			result: sent.ok ? "ok" : "failed",
			metadata: {
				tokenId: issued.id,
				...(sent.ok ? {} : { reason: sent.reason }),
				...metadata,
			},
		});
	}

	app.post("/auth/password-reset", async (request, reply) => {
		const dex = deps.dex;
		if (!dex) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const body = PasswordResetRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Enter your email address.");
		}
		const decision = await perAddress.attempt(addressKey(request.ip));
		if (!decision.allowed) {
			if (decision.audit) await auditThrottled(request, "password-reset-request");
			return sendError(
				reply,
				429,
				"RATE_LIMITED",
				"Too many reset requests from your network. Try again in an hour.",
			);
		}
		const metadata = requestMetadata(request);
		// Answer first, so the time taken says nothing about whether the account exists.
		detach(() => sendReset(dex, body.data.login, metadata));
		return reply.status(202).send({});
	});

	function badLink(reply: FastifyReply) {
		return sendError(
			reply,
			400,
			"RESET_LINK_INVALID",
			"This link has expired or was already used. Ask for a new one.",
		);
	}

	/** Set the new password for the account behind a link, ending every session. */
	async function complete(
		request: FastifyRequest,
		dex: DexApi,
		token: string,
		hash: string,
	): Promise<{ userId: string; email: string } | null> {
		try {
			return await db.transaction().execute(async (trx) => {
				let purpose: AccountEmailPurpose = "reset";
				let used = await consumeAccountEmailToken(trx, token, "reset");
				if (!used) {
					// An invitation's link opens the same page and sets the first password.
					purpose = "invite";
					used = await consumeAccountEmailToken(trx, token, "invite");
				}
				if (!used) return null;
				const user = await trx
					.selectFrom("users")
					.select(["oidc_subject"])
					.where("id", "=", used.userId)
					.where("oidc_issuer", "=", DEX_ACCOUNT_ISSUER)
					.where("disabled_at", "is", null)
					.executeTakeFirst();
				if (!user || user.oidc_subject === dexLocalSubject(LOCAL_ADMIN_USER_ID)) {
					throw new NoPassword();
				}
				const password = (await viaDex(dex.listPasswords())).find(
					(p) => dexLocalSubject(p.userId) === user.oidc_subject,
				);
				if (!password) throw new NoPassword();
				await endSessions(trx, used.userId);
				await revokeAccountEmailTokens(trx, used.userId);
				await trx
					.updateTable("users")
					.set({ must_change_password: false, updated_at: new Date().toISOString() })
					.where("id", "=", used.userId)
					.execute();
				await recordAudit(trx, {
					actor: `user:${used.userId}`,
					target: used.userId,
					action: RESET_DONE_ACTION,
					result: "ok",
					metadata: { tokenId: used.id, purpose, ...requestMetadata(request) },
				});
				// Last, so a failure rolls the rest back and the link still works.
				const updated = await viaDex(dex.updatePassword(password.email, hash));
				if (updated === "not_found") throw new NoPassword();
				return { userId: used.userId, email: password.email };
			});
		} catch (err) {
			if (err instanceof NoPassword) return null;
			throw err;
		}
	}

	app.post("/auth/password-reset/complete", async (request, reply) => {
		const dex = deps.dex;
		if (!dex) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const body = PasswordResetComplete.safeParse(request.body ?? {});
		if (!body.success) {
			// Zod's messages name the rule, never the value.
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				body.error.issues[0]?.message ?? "Invalid request",
			);
		}
		// SPEC.md section 24.13; checked before the link is used up.
		if (isBreachedPassword(body.data.password)) {
			return sendError(reply, 400, "VALIDATION_FAILED", BREACHED_PASSWORD_MESSAGE);
		}
		const decision = await badTokens.attempt(addressKey(request.ip));
		if (!decision.receipt) {
			if (decision.audit) await auditThrottled(request, "password-reset-complete");
			return sendError(
				reply,
				429,
				"RATE_LIMITED",
				"Too many tries with reset links. Please wait a few minutes and try again.",
			);
		}
		const hash = await hashDexPassword(body.data.password);
		let done: Awaited<ReturnType<typeof complete>>;
		try {
			done = await complete(request, dex, body.data.token, hash);
		} catch (err) {
			await badTokens.giveBack(decision.receipt);
			if (!(err instanceof DexCallFailed)) throw err;
			// The gRPC status only: the request carried a password.
			request.log.error({ grpcCode: err.grpcCode }, "dex call failed");
			return sendError(
				reply,
				503,
				"DEX_UNAVAILABLE",
				"Dex could not be reached. Try again.",
			);
		}
		if (!done) return badLink(reply);
		await badTokens.giveBack(decision.receipt);
		const { email } = done;
		detach(async () => {
			await sendAccountEmail(mail, email, resetConfirmationMessage(config.PUBLIC_URL));
		});
		// No session starts: the person signs in again, second factor and all.
		return reply.status(204).send();
	});
}
