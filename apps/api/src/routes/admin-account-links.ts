import {
	linkAccounts,
	listLinks,
	requireRole,
	requireUser,
	unlinkAccount,
} from "@portikus/auth";
import { type AdminAccountLinks, AdminLinkRequest } from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notifyLinkChange } from "../admin/link-notice.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { platformNameOf } from "../lti/platform-name.js";
import { requestMetadata } from "../sessions/start-session.js";

const adminOnly = { preHandler: requireRole("administrator") };
const UnlinkParams = z.object({
	id: z.string().uuid(),
	courseUserId: z.string().uuid(),
});

const REFUSALS = {
	not_found: "One of the accounts was not found.",
	not_course_account: "The account to link must be a course account.",
	not_sso_account: "The other account must be an SSO account.",
	not_authorized: "An administrator or disabled account cannot be linked to.",
	already_linked: "One of these accounts is already linked.",
} as const;

/** Linking and unlinking a course account and an SSO account for someone else (SPEC.md 20.1, ADR 0026). */
export function registerAdminAccountLinkRoutes(
	app: FastifyInstance,
	{ db, lti }: ServerDeps,
): void {
	async function currentLinks(userId: string): Promise<AdminAccountLinks> {
		const links = await listLinks(db, userId);
		return {
			links: links.map((link) => ({
				courseUserId: link.courseUserId,
				platformName: platformNameOf(lti, link.platformIssuer),
				displayName: link.displayName,
				linkedAt: link.linkedAt.toISOString(),
			})),
		};
	}

	async function displayNameOf(userId: string): Promise<string> {
		const row = await db
			.selectFrom("users")
			.select("display_name")
			.where("id", "=", userId)
			.executeTakeFirst();
		return row?.display_name ?? "A course account";
	}

	app.get("/admin/users/:id/links", adminOnly, async (request, reply) => {
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const user = await db
			.selectFrom("users")
			.select("id")
			.where("id", "=", params.id)
			.executeTakeFirst();
		if (!user) return sendError(reply, 404, "NOT_FOUND", "User not found");
		return currentLinks(params.id);
	});

	app.post("/admin/users/:id/links", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const body = AdminLinkRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Choose a course account.");
		}
		const { courseUserId } = body.data;
		const actor = `user:${admin.id}`;
		const course = { displayName: await displayNameOf(courseUserId) };

		const outcome = await db.transaction().execute(async (trx) => {
			const linked = await linkAccounts(trx, { courseUserId, userId: params.id });
			if (!linked.ok) return linked;
			const platformName = platformNameOf(lti, linked.platformIssuer);
			await recordAudit(trx, {
				actor,
				target: params.id,
				action: "user.linked",
				result: "ok",
				metadata: {
					platform: platformName,
					courseUserId,
					by: "administrator",
					...requestMetadata(request),
				},
			});
			if (linked.archivedWorkspaceId) {
				await recordAudit(trx, {
					actor,
					target: linked.archivedWorkspaceId,
					action: "workspace.archived",
					result: "ok",
					metadata: { reason: "account_linked", by: "administrator" },
				});
			}
			await notifyLinkChange(trx, params.id, "linked", { ...course, platformName });
			return linked;
		});

		if (!outcome.ok) {
			await recordAudit(db, {
				actor,
				target: params.id,
				action: "user.linked",
				result: "denied",
				metadata: {
					reason: outcome.reason,
					courseUserId,
					by: "administrator",
					...requestMetadata(request),
				},
			});
			const status = outcome.reason === "not_found" ? 404 : 400;
			const code = status === 404 ? "NOT_FOUND" : "VALIDATION_FAILED";
			return sendError(reply, status, code, REFUSALS[outcome.reason]);
		}
		return currentLinks(params.id);
	});

	// Works on any link, even when the SSO account is now disabled or an administrator.
	app.delete(
		"/admin/users/:id/links/:courseUserId",
		adminOnly,
		async (request, reply) => {
			const admin = requireUser(request);
			const params = parseOr400(UnlinkParams, request.params, reply);
			if (!params) return;
			const actor = `user:${admin.id}`;
			const courseName = await displayNameOf(params.courseUserId);

			const done = await db.transaction().execute(async (trx) => {
				const unlinked = await unlinkAccount(trx, {
					userId: params.id,
					courseUserId: params.courseUserId,
				});
				if (!unlinked) return false;
				const platformName = platformNameOf(lti, unlinked.platformIssuer);
				await recordAudit(trx, {
					actor,
					target: params.id,
					action: "user.unlinked",
					result: "ok",
					metadata: {
						platform: platformName,
						courseUserId: params.courseUserId,
						by: "administrator",
						...requestMetadata(request),
					},
				});
				if (unlinked.unarchivedWorkspaceId) {
					await recordAudit(trx, {
						actor,
						target: unlinked.unarchivedWorkspaceId,
						action: "workspace.unarchived",
						result: "ok",
						metadata: { reason: "account_unlinked", by: "administrator" },
					});
				}
				await notifyLinkChange(trx, params.id, "unlinked", {
					displayName: courseName,
					platformName,
				});
				return true;
			});
			if (!done) return sendError(reply, 404, "NOT_FOUND", "Link not found");
			return currentLinks(params.id);
		},
	);
}
