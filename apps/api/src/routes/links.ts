import {
	accountNeedsSecondFactor,
	checkSecondFactor,
	consumeLinkIntent,
	courseLinkWindow,
	hashSessionToken,
	isRecoveryCodeShape,
	linkAccounts,
	listLinks,
	loginCookieName,
	loginCookieOptions,
	markSecondFactorPassed,
	pendingLinkIntent,
	platformIssuerOf,
	requireUser,
	saveLinkIntent,
	secondFactorKey,
	sessionCookieName,
	sessionCookieOptions,
	sessionLinkState,
	unlinkAccount,
	useRecoveryCode,
} from "@portikus/auth";
import {
	type ApiError,
	LinkConfirm,
	type MyLinks,
	type PendingLink,
	type StartLinkResponse,
	type UnlinkResponse,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toAuthOptions } from "../auth-options.js";
import type { ServerDeps } from "../deps.js";
import type { SecondFactorThrottle } from "../second-factor-throttle.js";
import { requestMetadata, startSession } from "../sessions/start-session.js";

const CourseUserParam = z.object({ courseUserId: z.string().uuid() });

const TOO_LATE = "Open Portikus again from your course to link it.";

function fail(
	reply: FastifyReply,
	status: number,
	code: ApiError["code"],
	message: string,
) {
	return reply.status(status).send({ code, message });
}

/**
 * Linking a course account to an SSO account, and unlinking it
 * (ADR 0026). The OIDC callback's link mode
 * lives in auth.ts.
 */
export function registerLinkRoutes(
	app: FastifyInstance,
	{ db, config, oidc, lti }: ServerDeps,
	throttle: SecondFactorThrottle,
): void {
	const auth = toAuthOptions(config);
	const key = secondFactorKey(config.SECOND_FACTOR_KEY);

	/**
	 * What the SSO account must do before it can be linked. A later launch
	 * through the link asks for no code, so a Dex local-password account
	 * proves its second factor here (SPEC.md section 24.13).
	 */
	async function secondFactorOwed(userId: string): Promise<"verify" | "enrol" | null> {
		const row = await db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.select((eb) =>
				eb
					.exists(
						eb
							.selectFrom("user_second_factors")
							.select("user_second_factors.id")
							.whereRef("user_second_factors.user_id", "=", "users.id"),
					)
					.as("has_factor"),
			)
			.where("id", "=", userId)
			.executeTakeFirst();
		if (!row || !accountNeedsSecondFactor(row)) return null;
		return row.has_factor ? "verify" : "enrol";
	}

	/** Check the code for a link that needs one; on a refusal the reply is already sent. */
	async function passSecondFactor(
		request: FastifyRequest,
		reply: FastifyReply,
		userId: string,
		code: string | undefined,
	): Promise<"passed" | "not_needed" | "refused"> {
		const owed = await secondFactorOwed(userId);
		if (owed === null) return "not_needed";
		if (owed === "enrol") {
			fail(
				reply,
				403,
				"SECOND_FACTOR_REQUIRED",
				"Set up two-step sign-in first: sign in to Portikus with your password, then open Portikus from your course and link again.",
			);
			return "refused";
		}
		if (code === undefined) {
			fail(
				reply,
				403,
				"SECOND_FACTOR_REQUIRED",
				"Enter a code from your authenticator app, or a recovery code.",
			);
			return "refused";
		}
		// Linking takes no passkey, so only a recovery code may pass a refused count.
		const allowance = await throttle.allow(request, reply, userId, {
			sessionId: sessionId(request),
			eligible: isRecoveryCodeShape(code),
			passkeys: false,
		});
		if (!allowance) return "refused";
		const result =
			allowance.kind === "counted"
				? await checkSecondFactor(db, key, userId, code)
				: await useRecoveryCode(db, userId, code);
		await recordAudit(db, {
			actor: `user:${userId}`,
			target: userId,
			action: result.ok ? "auth.second_factor_verified" : "auth.second_factor_failed",
			result: result.ok ? "ok" : "failed",
			metadata: {
				...requestMetadata(request),
				...(result.ok ? { method: result.method } : {}),
				...(allowance.kind === "bypass" ? { bypass: true } : {}),
				flow: "link",
			},
		});
		if (!result.ok) {
			fail(
				reply,
				403,
				"WRONG_CODE",
				"That code is not right. Try the newest code from your app, or a recovery code.",
			);
			return "refused";
		}
		// A bypass holds no receipt, so nothing on that path gives a count back.
		if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
		return "passed";
	}

	/** The LTI registration's name, or the issuer's host when it is no longer registered. */
	function platformName(platformIssuer: string): string {
		const registered = lti?.platforms.find((p) => p.issuer === platformIssuer);
		if (registered) return registered.name;
		return URL.canParse(platformIssuer) ? new URL(platformIssuer).host : platformIssuer;
	}

	function sessionId(request: FastifyRequest): string {
		// The auth plugin sets the token with the user, so a signed-in route has it.
		return hashSessionToken(request.sessionToken ?? "");
	}

	async function myLinks(request: FastifyRequest): Promise<MyLinks> {
		const user = requireUser(request);
		const state = await sessionLinkState(db, sessionId(request));
		// Only an unlinked course account has a window; a linked one cannot sign in.
		const window = state?.window ?? null;
		const origin = state?.origin;
		const links = window ? [] : await listLinks(db, user.id);
		const launched =
			origin?.method === "lti"
				? links.find((link) => link.courseUserId === origin.courseUserId)
				: undefined;
		return {
			source: window ? "course" : "sso",
			linkUntil: window ? window.linkUntil.toISOString() : null,
			launch: launched
				? {
						courseUserId: launched.courseUserId,
						platformName: platformName(launched.platformIssuer),
					}
				: null,
			links: links.map((link) => ({
				courseUserId: link.courseUserId,
				platformName: platformName(link.platformIssuer),
				displayName: link.displayName,
				linkedAt: link.linkedAt.toISOString(),
			})),
		};
	}

	app.get("/me/links", async (request) => myLinks(request));

	// Only a recent course session may start a link.
	app.post("/me/links/start", async (request, reply) => {
		if (!oidc) return fail(reply, 500, "INTERNAL", "Login is not configured");
		const window = await courseLinkWindow(db, sessionId(request));
		if (!window) {
			return fail(
				reply,
				400,
				"VALIDATION_FAILED",
				"Only a course account can be linked to an SSO account.",
			);
		}
		if (!window.open) return fail(reply, 400, "VALIDATION_FAILED", TOO_LATE);

		const { url, state } = await oidc.buildLoginRedirect({ prompt: "login" });
		await saveLinkIntent(db, {
			state: state.state,
			sessionId: sessionId(request),
			courseUserId: window.courseUserId,
		});
		reply.setCookie(loginCookieName(auth), JSON.stringify(state), {
			...loginCookieOptions(auth),
			signed: true,
		});
		const body: StartLinkResponse = { redirectUrl: url };
		return body;
	});

	// The two accounts the confirmation page names.
	app.get("/me/links/pending", async (request, reply) => {
		const pending = await pendingLinkIntent(db, sessionId(request));
		if (!pending) return fail(reply, 404, "NOT_FOUND", "No link is waiting.");
		const rows = await db
			.selectFrom("users")
			.select(["id", "display_name", "email", "preferred_username", "oidc_issuer"])
			.where("id", "in", [pending.courseUserId, pending.userId])
			.execute();
		const course = rows.find((row) => row.id === pending.courseUserId);
		const sso = rows.find((row) => row.id === pending.userId);
		if (!course || !sso) return fail(reply, 404, "NOT_FOUND", "No link is waiting.");
		const body: PendingLink = {
			course: {
				displayName: course.display_name,
				platformName: platformName(platformIssuerOf(course.oidc_issuer)),
			},
			sso: {
				displayName: sso.display_name,
				signInName: sso.preferred_username || null,
				email: sso.email,
			},
			secondFactor: await secondFactorOwed(sso.id),
		};
		return body;
	});

	// Link, retire the course account, and sign in to the SSO account.
	app.post("/me/links/confirm", async (request, reply) => {
		const input = LinkConfirm.safeParse(request.body ?? {});
		if (!input.success) {
			return fail(reply, 400, "VALIDATION_FAILED", "Enter a code to link.");
		}
		const id = sessionId(request);
		// Checked before the intent is used, so a wrong code can be retried.
		const pending = await pendingLinkIntent(db, id);
		const checked = pending
			? await passSecondFactor(request, reply, pending.userId, input.data.code)
			: "not_needed";
		if (checked === "refused") return reply;
		const outcome = await db.transaction().execute(async (trx) => {
			const intent = await consumeLinkIntent(trx, id);
			if (!intent) return { kind: "none" as const };
			// The code proved this account; any other is never linked.
			if (intent.userId !== pending?.userId) return { kind: "none" as const };
			const window = await courseLinkWindow(trx, id);
			if (!window?.open || window.courseUserId !== intent.courseUserId) {
				return { kind: "too_late" as const, intent };
			}
			const linked = await linkAccounts(trx, intent);
			if (!linked.ok)
				return { kind: "refused" as const, intent, reason: linked.reason };

			const ssoActor = `user:${intent.userId}`;
			await recordAudit(trx, {
				actor: ssoActor,
				target: intent.userId,
				action: "user.linked",
				result: "ok",
				metadata: {
					platform: platformName(linked.platformIssuer),
					courseUserId: intent.courseUserId,
					...requestMetadata(request),
				},
			});
			if (linked.archivedWorkspaceId) {
				await recordAudit(trx, {
					actor: ssoActor,
					target: linked.archivedWorkspaceId,
					action: "workspace.archived",
					result: "ok",
					metadata: { reason: "account_linked" },
				});
			}
			return { kind: "linked" as const, intent };
		});

		if (outcome.kind === "none") {
			return fail(reply, 404, "NOT_FOUND", "No link is waiting.");
		}
		const { intent } = outcome;
		if (outcome.kind !== "linked") {
			const reason = outcome.kind === "too_late" ? "expired" : outcome.reason;
			await recordAudit(db, {
				actor: `user:${intent.userId}`,
				target: intent.userId,
				action: "user.linked",
				result: "denied",
				metadata: {
					reason,
					courseUserId: intent.courseUserId,
					...requestMetadata(request),
				},
			});
			const message =
				outcome.kind === "too_late"
					? TOO_LATE
					: reason === "already_linked"
						? "This SSO account already has a link from this course system."
						: "These accounts cannot be linked.";
			return fail(reply, 400, "VALIDATION_FAILED", message);
		}

		const newSession = await startSession(db, auth, reply, intent.userId, {
			method: "link",
			courseUserId: null,
		});
		// The code typed above is this session's second factor.
		if (checked === "passed") await markSecondFactorPassed(db, newSession);
		await recordAudit(db, {
			actor: `user:${intent.userId}`,
			target: intent.userId,
			action: "auth.login",
			result: "ok",
			metadata: {
				method: "link",
				...requestMetadata(request),
			},
		});
		return {};
	});

	// The SSO account removes one of its links. A session
	// launched through a linked course identity may remove only that link,
	// and then ends with every other session that came through
	// the identity.
	app.post("/me/links/:courseUserId/unlink", async (request, reply) => {
		const user = requireUser(request);
		const params = CourseUserParam.safeParse(request.params);
		if (!params.success) {
			return fail(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const courseUserId = params.data.courseUserId;
		const origin = (await sessionLinkState(db, sessionId(request)))?.origin;
		const courseSide = origin?.method === "lti";
		if (courseSide && origin.courseUserId !== courseUserId) {
			return fail(reply, 404, "NOT_FOUND", "Link not found");
		}
		const done = await db.transaction().execute(async (trx) => {
			const unlinked = await unlinkAccount(trx, { userId: user.id, courseUserId });
			if (!unlinked) return false;
			const actor = courseSide ? `user:${courseUserId}` : `user:${user.id}`;
			await recordAudit(trx, {
				actor: actor,
				target: user.id,
				action: "user.unlinked",
				result: "ok",
				metadata: {
					platform: platformName(unlinked.platformIssuer),
					courseUserId,
					side: courseSide ? "course" : "sso",
					...requestMetadata(request),
				},
			});
			if (unlinked.unarchivedWorkspaceId) {
				await recordAudit(trx, {
					actor: actor,
					target: unlinked.unarchivedWorkspaceId,
					action: "workspace.unarchived",
					result: "ok",
					metadata: { reason: "account_unlinked" },
				});
			}
			return true;
		});
		if (!done) return fail(reply, 404, "NOT_FOUND", "Link not found");
		// The unlink already ended this session with the others from the identity.
		if (courseSide) {
			reply.clearCookie(sessionCookieName(auth), sessionCookieOptions(auth));
		}
		const body: UnlinkResponse = { signedOut: courseSide };
		return body;
	});
}
