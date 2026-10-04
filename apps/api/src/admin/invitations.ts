import type { CreateInvitationRequest, Invitation, Role } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";

export const INVITATION_COLUMNS = [
	"id",
	"email",
	"username",
	"display_name",
	"role",
	"created_at",
] as const;

interface InvitationRow {
	id: string;
	email: string;
	username: string | null;
	display_name: string;
	role: string;
	created_at: Date;
}

export function toInvitation(row: InvitationRow): Invitation {
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
 * Write one invitation and its audit row (SPEC.md section 24.13). A second
 * waiting invitation for the email fails with a unique violation.
 */
export async function createInvitation(
	db: Kysely<Database>,
	actorId: string,
	body: CreateInvitationRequest,
	metadata: Record<string, unknown>,
): Promise<Invitation> {
	const row = await db.transaction().execute(async (trx) => {
		const created = await trx
			.insertInto("account_invitations")
			.values({
				email: body.email,
				username: body.username ?? null,
				display_name: body.name,
				role: body.role,
				created_by: actorId,
			})
			.returning(INVITATION_COLUMNS)
			.executeTakeFirstOrThrow();
		await recordAudit(trx, {
			actor: `user:${actorId}`,
			target: `invitation:${created.id}`,
			action: "admin.invitation_created",
			result: "ok",
			metadata: { role: body.role, ...metadata },
		});
		return created;
	});
	return toInvitation(row);
}
