import { requireRole, requireUser } from "@portikus/auth";
import {
	CreateInvitationRequest,
	type Invitation,
	type InvitationList,
	type Role,
} from "@portikus/contracts";
import { isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import { requestMetadata } from "../sessions/start-session.js";

interface InvitationRow {
	id: string;
	email: string;
	username: string | null;
	display_name: string;
	role: string;
	created_at: Date;
}

const COLUMNS = [
	"id",
	"email",
	"username",
	"display_name",
	"role",
	"created_at",
] as const;

function toInvitation(row: InvitationRow): Invitation {
	return {
		id: row.id,
		email: row.email,
		username: row.username,
		displayName: row.display_name,
		role: row.role as Role,
		createdAt: row.created_at.toISOString(),
	};
}

/**
 * Invite, list and revoke invitations; a first sign-in from an upstream
 * provider creates an account only by claiming one (SPEC.md §24.13).
 */
export function registerAdminInvitationRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	const adminOnly = { preHandler: requireRole("administrator") };

	app.get("/admin/invitations", adminOnly, async () => {
		const rows = await db
			.selectFrom("account_invitations")
			.select(COLUMNS)
			.where("claimed_at", "is", null)
			.where("revoked_at", "is", null)
			.orderBy("created_at", "desc")
			.execute();
		const out: InvitationList = { invitations: rows.map(toInvitation) };
		return out;
	});

	app.post("/admin/invitations", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const body = parseOr400(CreateInvitationRequest, request.body ?? {}, reply);
		if (!body) return;
		try {
			const row = await db.transaction().execute(async (trx) => {
				const created = await trx
					.insertInto("account_invitations")
					.values({
						email: body.email,
						username: body.username ?? null,
						display_name: body.name,
						role: body.role,
						created_by: actor.id,
					})
					.returning(COLUMNS)
					.executeTakeFirstOrThrow();
				await recordAudit(trx, {
					actor: `user:${actor.id}`,
					target: `invitation:${created.id}`,
					action: "admin.invitation_created",
					result: "ok",
					metadata: { role: body.role, ...requestMetadata(request) },
				});
				return created;
			});
			return reply.status(201).send(toInvitation(row));
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			return sendError(
				reply,
				409,
				"INVITATION_EXISTS",
				"This email already has an invitation waiting.",
			);
		}
	});

	app.post("/admin/invitations/:id/revoke", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		const row = await db.transaction().execute(async (trx) => {
			const revoked = await trx
				.updateTable("account_invitations")
				.set({ revoked_at: new Date().toISOString() })
				.where("id", "=", params.id)
				.where("claimed_at", "is", null)
				.where("revoked_at", "is", null)
				.returning(COLUMNS)
				.executeTakeFirst();
			if (!revoked) return null;
			await recordAudit(trx, {
				actor: `user:${actor.id}`,
				target: `invitation:${revoked.id}`,
				action: "admin.invitation_revoked",
				result: "ok",
				metadata: { ...requestMetadata(request) },
			});
			return revoked;
		});
		if (!row) {
			return sendError(reply, 404, "NOT_FOUND", "No waiting invitation with this ID.");
		}
		return toInvitation(row);
	});
}
