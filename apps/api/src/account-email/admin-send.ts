import { recordAudit } from "@portikus/db";
import type { FastifyReply } from "fastify";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";
import { createStoredCounter, type StoredCounter } from "../stored-counter.js";
import {
	type AccountMessage,
	inviteMessage,
	resetMessage,
	ssoInvitationMessage,
} from "./messages.js";
import { accountEmailDeps, sendAccountEmail } from "./send.js";
import {
	type AccountEmailPurpose,
	issueAccountEmailToken,
	supersedeAccountEmailTokens,
} from "./tokens.js";

/**
 * Account email an administrator sends: a set-password link to a Dex user,
 * or an SSO invitation (SPEC.md section 5.3). Capped at five an hour per
 * account so a careless or hostile administrator cannot bomb a mailbox.
 */

const ADMIN_SEND_LIMIT = 5;
const ONE_HOUR_MS = 60 * 60_000;

export type AdminSendResult = "sent" | "throttled" | "disabled" | "no-smtp" | "failed";

export interface AdminSender {
	/** Issue a link and email it to the address Dex holds for the account. */
	setPasswordLink(input: {
		userId: string;
		actorId: string;
		purpose: AccountEmailPurpose;
		to: string;
	}): Promise<AdminSendResult>;
	/** Email an SSO invitation, which carries no token. */
	invitation(input: {
		invitationId: string;
		actorId: string;
		to: string;
	}): Promise<AdminSendResult>;
	/** Email the old address that the account's email changed; not counted. */
	notice(to: string, message: AccountMessage): Promise<AdminSendResult>;
}

export function createAdminSender(deps: ServerDeps): AdminSender {
	const { db, config } = deps;
	const mail = accountEmailDeps(deps);
	const counter: StoredCounter = createStoredCounter({
		db,
		logger: deps.logger,
		scope: "admin-account-email",
		limit: ADMIN_SEND_LIMIT,
		windowMs: ONE_HOUR_MS,
	});

	/** Count one send; audit the window's first refusal. */
	async function allowed(
		key: string,
		actorId: string,
		target: string,
	): Promise<boolean> {
		const decision = await counter.attempt(key);
		if (decision.allowed) return true;
		if (decision.audit) {
			await recordAudit(db, {
				actor: `user:${actorId}`,
				target,
				action: "auth.throttled",
				result: "denied",
				metadata: { scope: counter.scope },
			});
		}
		return false;
	}

	async function send(to: string, message: AccountMessage): Promise<AdminSendResult> {
		const result = await sendAccountEmail(mail, to, message);
		return result.ok ? "sent" : result.reason;
	}

	return {
		async setPasswordLink({ userId, actorId, purpose, to }) {
			if (!(await allowed(`user:${userId}`, actorId, userId))) return "throttled";
			const issued = await issueAccountEmailToken(db, {
				userId,
				purpose,
				createdBy: actorId,
			});
			const build = purpose === "invite" ? inviteMessage : resetMessage;
			const result = await send(to, build(config.PUBLIC_URL, issued.token));
			if (result === "sent") {
				await supersedeAccountEmailTokens(db, { userId, purpose, keepId: issued.id });
			}
			// The row id only, never the token or the address (SPEC.md section 24.8).
			await recordAudit(db, {
				actor: `user:${actorId}`,
				target: userId,
				action:
					purpose === "invite" ? "dex_user.invite_sent" : "dex_user.reset_link_sent",
				result: result === "sent" ? "ok" : "failed",
				metadata: { tokenId: issued.id },
			});
			return result;
		},
		async invitation({ invitationId, actorId, to }) {
			const target = `invitation:${invitationId}`;
			if (!(await allowed(`invitation:${to}`, actorId, target))) return "throttled";
			const result = await send(to, ssoInvitationMessage(config.PUBLIC_URL));
			await recordAudit(db, {
				actor: `user:${actorId}`,
				target,
				action: "admin.invitation_emailed",
				result: result === "sent" ? "ok" : "failed",
				metadata: {},
			});
			return result;
		},
		notice: send,
	};
}

/** The words an administrator sees when an email did not go out. */
const FAILURE_TEXT: Record<Exclude<AdminSendResult, "sent">, string> = {
	throttled:
		"Five emails were already sent to this account in the last hour. Try again later.",
	disabled: "Account email is off. Turn it on in Settings first.",
	"no-smtp": "No mail server is set in the notification settings.",
	failed: "The mail server did not take the message. Try again.",
};

/** Answer a request whose email did not go out. */
export function sendAdminSendFailure(
	reply: FastifyReply,
	result: Exclude<AdminSendResult, "sent">,
): FastifyReply {
	if (result === "throttled") {
		return sendError(reply, 429, "RATE_LIMITED", FAILURE_TEXT.throttled);
	}
	if (result === "disabled") {
		return sendError(reply, 409, "ACCOUNT_EMAIL_OFF", FAILURE_TEXT.disabled);
	}
	return sendError(reply, 503, "EMAIL_NOT_SENT", FAILURE_TEXT[result]);
}
