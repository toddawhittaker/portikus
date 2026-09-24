import {
	consumeLinkIntent,
	courseLinkWindow,
	hashSessionToken,
	linkAccounts,
	listLinks,
	loginCookieName,
	loginCookieOptions,
	pendingLinkIntent,
	requireUser,
	saveLinkIntent,
	unlinkAccount,
} from "@portikus/auth";
import type {
	ApiError,
	MyLinks,
	PendingLink,
	StartLinkResponse,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toAuthOptions } from "../auth-options.js";
import type { ServerDeps } from "../server.js";
import { audit, requestMetadata, startSession } from "./start-session.js";

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
 * (docs/EPIC-13-1.md, "The flow"; ADR 0026). The OIDC callback's link mode
 * lives in auth.ts.
 */
export function registerLinkRoutes(
	app: FastifyInstance,
	{ db, config, oidc, lti }: ServerDeps,
): void {
	const auth = toAuthOptions(config);

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
		const row = await db
			.selectFrom("users")
			.select("oidc_issuer")
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		const course = row.oidc_issuer.startsWith("lti:");
		const window = course ? await courseLinkWindow(db, sessionId(request)) : null;
		const links = course ? [] : await listLinks(db, user.id);
		return {
			source: course ? "course" : "sso",
			linkUntil: window ? window.linkUntil.toISOString() : null,
			links: links.map((link) => ({
				courseUserId: link.courseUserId,
				platformName: platformName(link.platformIssuer),
				displayName: link.displayName,
				linkedAt: link.linkedAt.toISOString(),
			})),
		};
	}

	app.get("/me/links", async (request) => myLinks(request));

	// Step 2: only a recent course session may start a link (rulings 10 and 11).
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

	// Step 4: the two accounts the confirmation page names.
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
				platformName: platformName(course.oidc_issuer.replace(/^lti:/, "")),
			},
			sso: {
				displayName: sso.display_name,
				signInName: sso.preferred_username || null,
				email: sso.email,
			},
		};
		return body;
	});

	// Step 5: link, retire the course account, and sign in to the SSO account.
	app.post("/me/links/confirm", async (request, reply) => {
		const id = sessionId(request);
		const outcome = await db.transaction().execute(async (trx) => {
			const intent = await consumeLinkIntent(trx, id);
			if (!intent) return { kind: "none" as const };
			const window = await courseLinkWindow(trx, id);
			if (!window?.open || window.courseUserId !== intent.courseUserId) {
				return { kind: "too_late" as const, intent };
			}
			const linked = await linkAccounts(trx, intent);
			if (!linked.ok)
				return { kind: "refused" as const, intent, reason: linked.reason };

			const ssoActor = `user:${intent.userId}`;
			await audit(trx, "user.linked", ssoActor, intent.userId, "ok", {
				platform: platformName(linked.platformIssuer),
				courseUserId: intent.courseUserId,
				...requestMetadata(request),
			});
			if (linked.archivedWorkspaceId) {
				await audit(
					trx,
					"workspace.archived",
					ssoActor,
					linked.archivedWorkspaceId,
					"ok",
					{ reason: "account_linked" },
				);
			}
			return { kind: "linked" as const, intent };
		});

		if (outcome.kind === "none") {
			return fail(reply, 404, "NOT_FOUND", "No link is waiting.");
		}
		const { intent } = outcome;
		if (outcome.kind !== "linked") {
			const reason = outcome.kind === "too_late" ? "expired" : outcome.reason;
			await audit(db, "user.linked", `user:${intent.userId}`, intent.userId, "denied", {
				reason,
				courseUserId: intent.courseUserId,
				...requestMetadata(request),
			});
			const message =
				outcome.kind === "too_late"
					? TOO_LATE
					: reason === "already_linked"
						? "This SSO account already has a link from this course system."
						: "These accounts cannot be linked.";
			return fail(reply, 400, "VALIDATION_FAILED", message);
		}

		await startSession(db, auth, reply, intent.userId);
		await audit(db, "auth.login", `user:${intent.userId}`, intent.userId, "ok", {
			method: "link",
			...requestMetadata(request),
		});
		return {};
	});

	// Step 7: the SSO account removes one of its links (ruling 15).
	app.post("/me/links/:courseUserId/unlink", async (request, reply) => {
		const user = requireUser(request);
		const params = CourseUserParam.safeParse(request.params);
		if (!params.success) {
			return fail(reply, 400, "VALIDATION_FAILED", params.error.message);
		}
		const courseUserId = params.data.courseUserId;
		const done = await db.transaction().execute(async (trx) => {
			const unlinked = await unlinkAccount(trx, { userId: user.id, courseUserId });
			if (!unlinked) return false;
			const actor = `user:${user.id}`;
			await audit(trx, "user.unlinked", actor, user.id, "ok", {
				platform: platformName(unlinked.platformIssuer),
				courseUserId,
				...requestMetadata(request),
			});
			if (unlinked.unarchivedWorkspaceId) {
				await audit(
					trx,
					"workspace.unarchived",
					actor,
					unlinked.unarchivedWorkspaceId,
					"ok",
					{ reason: "account_unlinked" },
				);
			}
			return true;
		});
		if (!done) return fail(reply, 404, "NOT_FOUND", "Link not found");
		return {};
	});
}
